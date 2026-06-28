# Orchestrator Layer — Design Spec

Date: 2026-06-28. Status: **design approved; not yet planned or implemented.**

## Goal

Add an LLM **orchestrator** that owns a high-level task end-to-end ("под ключ")
and decides, step by step, which **worker** agent (codex, minimax) to run next.
Workers execute; they do not call each other — the orchestrator routes. The human
gives the task and accepts the risk; there are no correctness validators or
guarantees beyond the orchestration itself.

The defining constraint is **orchestrator context hygiene**: the orchestrator
reasons from a fresh, high-level view and is never polluted by raw code/diffs, so
its judgement does not degrade as the task grows.

This is a deliberate move past the project's original "no workflow engine"
non-goal, scoped to the minimum that delivers orchestration — nothing more.

## Core decisions (from the brainstorm)

1. **Orchestrator is an LLM** (not deterministic code), reasoning about what to do
   next.
2. **Memory is per-task (one task = one session).** Within a task, the
   orchestrator AND each worker keep their own persistent conversation; a new task
   starts everyone empty. The orchestrator's memory *accumulates* but stays
   high-level by its input diet (decision 3).
3. **The orchestrator only ever receives bounded summaries** of worker output
   (status + what-was-done + artifacts-by-reference/sha) — never raw diffs/files.
4. **Decisions are a strict schema**, not parsed from free text.
5. **Workers receive a scoped sub-task plus the original goal as background** (not
   the full task to self-orient, not a bare chunk).

## Approach: A — new layer alongside duet

Build `orchestrate` as a new command + loop that composes the already-extracted
`lib/` transports. The duet relay is **untouched** (separate commands, separate
state); only low-level transports/lock/budgets are shared. Additive, low-risk,
keeps the 126 existing tests green. The duet relay (and its soon-irrelevant bugs)
is retired in a later, separate step once the orchestrator proves out. Approaches
B (replace duet) and C (generalize duet into a shared engine) were rejected for a
first version — B is a high-risk big-bang, C is premature generality against the
"minimal" constraint. C remains the natural *future* once the orchestrator's real
shape is known.

## 1. Components and boundaries

| Component | Responsibility | Depends on |
|-----------|----------------|------------|
| `lib/orchestrator.mjs` | the loop: gather state → ask orchestrator → parse decision → run worker → record summary → repeat | registry, worker-runner, state |
| participant registry | `{ id, kind: orchestrator\|worker, transport, session, role, memory }` | config |
| worker-runner | uniform "give sub-task → return bounded summary" over `runCodexExecTurn` / MiniMax `sendPrompt` | `codex-exec`, `mvs-client` |
| orchestrator-runner | call the LLM orchestrator with the strict decision schema | `mvs-client` (or a configured model) |
| orchestrator state | `orch-state.json` + `orch-journal.md` (separate from duet), under `duet-lock` | `duet-lock`, atomic write |
| `bridge.mjs` | CLI dispatch for `orchestrate start/status/resume` | all of the above |

Boundary with duet: **zero** — separate commands and state; only the low-level
transports, lock, and budget primitives are shared.

## 2. Data flow and state

**Start:** `orchestrate start --task <file>` creates `orch-state.json` (task,
participants, budgets, `status=running`, `step=0`) and `orch-journal.md` under the
lock. Each participant is given a session: MiniMax a native opencode session
(`createSession` → `mvs_…`); codex a logical session id for bridge-managed memory.

**Loop (the orchestrator goes first each cycle — it is the router):**

```
1. Bridge → orchestrator: the new result-summary of the prior step
   (the orchestrator remembers the rest — persistent session).
   Step 0: just the task, empty ledger.
2. Orchestrator (LLM) → strict decision: {action: run|done|escalate, worker, subtask, note}
3a. run → worker-runner gives the worker {subtask + goal-as-background};
    the worker runs in its OWN persistent session;
    bridge produces a bounded summary (status + what-done + artifacts-by-ref/sha);
    summary → ledger + journal. Raw output is NOT shown to the orchestrator.
3b. done/escalate → loop ends, final summary.
4. Budget / iteration caps checked; --yes gates spend.
5. State written atomically (state BEFORE journal — audit lesson P2-10).
```

**State:**
- `orch-state.json` — `{ task, status, step, participants:[{id,kind,transport,sessionId,memory}], ledger:[{step,worker,subtask,summary,status,ts}], budget:{maxSteps,maxTokens,spent}, lastDecision }`
- `orch-journal.md` — human-readable trail (decisions + notes + summaries),
  append-only, for "под ключ" observation.

**Durability invariant:** the `ledger` is the **durable source of truth**; the
orchestrator's LLM session is live working memory. If that session is lost
(crash/resume), the bridge rebuilds the orchestrator's context from the ledger.
This also gives `orchestrate status` and `orchestrate resume` for free.

## 3. Decision protocol

Each turn the orchestrator returns one structured decision; only it drives the
loop:

```json
{
  "action": "run | done | escalate",
  "worker":  "<id from registry>",   // for run
  "subtask": "<focused instruction for this turn>",  // for run
  "summary": "<final outcome>",      // for done
  "reason":  "<why a human is needed>",  // for escalate
  "note":    "<free-form rationale — written to journal, does NOT control>"
}
```

Mechanism (minimal, transport-agnostic):
1. The orchestrator's (stable, cacheable) system prompt declares the schema + the
   available workers and their capabilities (codex = edits/executes files; minimax
   = review/reasoning, no file edits).
2. The orchestrator emits one JSON block; the bridge extracts and **validates
   against the schema**.
3. **Fail-closed:** invalid JSON / unknown `action` / `worker` not in the registry
   / empty `subtask` → one re-prompt → still invalid → **escalate to human**, never
   guessing.

Key points:
- **Only the validated object controls.** Free text (incl. `note`) is recorded but
  inert — this closes the audit's "trust reconstructed from untrusted text" class
  by trusting the *schema*, not parsed prose.
- **`worker` is validated against the registry**, not against `"codex"/"minimax"`
  literals — adding a worker later does not touch the parser.
- If a transport supports native tool-calls / structured output, use it; the
  JSON-block path is the default fallback.

## 4. Executor memory (incl. codex statelessness)

Each worker keeps its own context for the whole task; a new task is fresh.

- **MiniMax — free.** Native opencode sessions: one `createSession` per task, then
  every `sendPrompt` to that session id; the model remembers natively. Already
  supported by `mvs-client`.
- **Codex — needs a mechanism** (today `--ephemeral`, no memory). Two layers:
  1. **Durable layer = files.** If codex's exec workspace is **per-task
     persistent**, its prior work physically persists on disk and it re-reads it —
     this is the primary memory, no heavy transcript replay.
  2. **Light layer = bounded re-injection.** Before each codex turn the bridge
     prepends a short "your prior turns in this task: [subtask → summary]…"
     (char-bounded, like `duetPacketMaxChars`) + the new sub-task + goal background.

**Workspace decoupling (also fixes audit P2-2):** the orchestrator's codex worker
runs in a **per-task persistent workspace, NOT `bridgeDir`**. Today exec mode uses
`bridgeDir`/`workspace-write` (codex could overwrite `bridge.mjs`). The
orchestrator adds a third workspace mode: a dedicated task directory,
`workspace-write`, persisting across turns within the task, cleaned/retained at
task end. This is both the memory substrate and isolation from the bridge.

The participant registry carries `memory: 'native-session' | 'workspace+reinject'`;
the worker-runner dispatches per strategy.

**Verify during implementation (not a blocker):** if the codex CLI supports native
resume/session, prefer it over the light re-injection layer; the
workspace+re-injection path works regardless.

## 5. Termination and budget

Three termination paths:
1. Orchestrator decides `done` (with `summary`) → `status=done`.
2. Orchestrator decides `escalate` (with `reason`) → `status=escalated`.
3. **Hard caps (backstop)** even if the orchestrator loops without finishing:
   - `maxSteps` — cap on orchestrator decisions.
   - `maxTokens` — cumulative budget (orchestrator + all workers), checked BEFORE
     each LLM call; a call that would exceed it stops the loop.
   - On a cap → **graceful `escalated`/`budget_exhausted` with a clean final
     summary, NOT an uncaught throw** (direct lesson from audit P1-5).

**Worker failure = an orchestrator decision (no middleware):** a worker crash /
HTTP failure is recorded as that step's result-summary with `status: error` and
fed to the orchestrator, which decides what to do (retry via another worker,
escalate). Failures become routing decisions, not crashes. No retry policies, no
correctness validators.

**Spend gating:** `--yes` required (every step is ≥1 LLM call). `orchestrate start
--yes` runs autonomously to `done`/`escalate`/cap.

**Honest `--dry-run`:** because the loop is LLM-driven and unpredictable, dry-run
does NOT simulate the whole run — it validates config/participants/budgets, shows
the first orchestrator prompt, and estimates per-step cost, while explicitly
stating it cannot predict the step count (avoids the P1-8 illusion).

**Commands (minimal):** `orchestrate start` (autonomous loop), `orchestrate status`
(inspect ledger/state), `orchestrate resume` (from the durable ledger after a
crash). Without `--yes`, only the preflight runs.

## 6. Testing (offline, deterministic, TDD)

The orchestrator and workers are LLMs, so tests must be offline and token-free,
using the existing `MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY` hook and real
`node:http` servers.

**Key enabler — a scriptable decision queue.** Extend the fake-reply mechanism so
a test scripts a *sequence*: orchestrator→`{run codex "X"}` → codex→`"done X"` →
orchestrator→`{run minimax "review"}` → minimax→`"ok"` → orchestrator→`{done}`.
The full loop runs deterministically, no tokens.

Unit tests (pure): schema validation (valid run/done/escalate; invalid
action/worker-not-in-registry/empty-subtask → reject; fail-closed
re-prompt→escalate); bounded-summary production; ledger/state shape + atomic
state-before-journal write; budget (`maxSteps` → graceful escalate, `maxTokens` →
stop before exceeding); codex re-injection block + memory-strategy dispatch;
worker failure → error-summary fed to orchestrator (not a throw).

Integration tests (scripted, offline): happy path to `done` with correct ledger;
escalate path; `maxSteps` backstop; budget backstop; resume (interrupt → re-read
`orch-state` → continue); a real `node:http` server standing in for the MiniMax
transport (as in `lib-mvs-client`/`lib-http-json`).

Guarantees: no real codex/MiniMax spawned in tests (codex via the fake hook;
MiniMax via a local server + scripted replies); everything under
`test:release`/`test:offline`; zero spend in CI. The additive design keeps the 126
existing duet tests green as the regression net. Each piece is built
RED→GREEN→refactor and its tests are mutation-meaningful (fail if the behavior is
removed), as with the verifier tests.

## Non-goals (the agreed minimum)

No correctness validators, no "done correctly" guarantees, no retry policies, no
per-worker sub-budgets, no parallel/fan-out workers, no upfront task decomposition
(routing is reactive), no user-defined pipeline yet (a possible later *mode*). The
human owns the risk.

## Relationship to existing code & audit

- Reuses the post-Phase-2 `lib/` transports (`codex-exec`, `mvs-client`,
  `http-json`), `duet-lock`, atomic writes, `textSummary`/bounded packets, the
  `--yes`/budget machinery, and the `fakeModelReplyFromEnv` test hook.
- Retires by design the audit's worst class (P2-1/P2-3 "trust from journal text")
  via the strict decision schema; sidesteps P2-2 via the per-task workspace; avoids
  P1-5/P1-8 by graceful caps and an honest dry-run.
- The duet relay and its in-flight bug fixes are left as-is; duet is retired only
  after the orchestrator is proven.

## Open items to settle during planning/implementation

- Which model is the orchestrator (default MiniMax/opencode session vs a
  configured model); confirm opencode supports a dedicated orchestrator session.
- Whether the codex CLI offers native resume (prefer it if so).
- Exact bounded-summary shape a worker returns (fields the orchestrator needs to
  route well without raw output).
