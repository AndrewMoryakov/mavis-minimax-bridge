# Orchestrator Layer — Design Spec

Date: 2026-06-28. Status: **approved for implementation planning — design only, not
yet implemented.**

**Scope note — deliberately the simplest viable orchestrator.** A production-grade,
crash-durable, unattended version is a *separate* project; this is the light,
local, human-in-the-loop tool. Earlier review rounds pushed toward production
durability — a write-ahead-log state machine with `intent/result/applied` brackets
on every spend-bearing call and a multi-row crash-recovery matrix. After review,
that was **rolled back** as over-built for this MVP: there is a human in the loop
who owns the risk, so the design uses a plain **append-only log + one
human-decision rule** for the single ambiguous crash case, not a formal recovery
state machine. Kept from review (cheap and genuinely useful): the worker-summary
chokepoint, capability-bounding, honest budget semantics, a dedicated `orch.lock`,
realpath target validation, and the runtime-files contract.

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
   Enforced at one chokepoint with an explicit schema + cap (§4a), not as a promise.
4. **Decisions are a strict schema**, not parsed from free text.
5. **Workers receive a scoped sub-task plus the original goal as background** (not
   the full task to self-orient, not a bare chunk).

## Approach: A — new layer alongside duet

Build `orchestrate` as a new command + loop that composes the already-extracted
`lib/` transports. The duet relay is **untouched** (separate commands, separate
state); only low-level transports/lock/budgets are shared. Additive, low-risk,
keeps the 130 existing tests green. The duet relay (and its soon-irrelevant bugs)
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
| orchestrator state | `orch-ledger.jsonl` (append-only log, the durable record) + `orch-journal.md` (human trail) + a small best-effort `orch-state.json` projection (fast `status`); guarded by a **dedicated `orch.lock`** via the `lib/duet-lock` helper | `lib/duet-lock` helper, atomic write |
| `bridge.mjs` | CLI dispatch for `orchestrate start/status/resume` | all of the above |

Boundary with duet: **zero** — separate commands and separate state files
(`orch-*`). Only the low-level *primitives* are shared: the transports, the
lock **helper** (`lib/duet-lock.mjs`, but a separate `orch.lock` file so duet and
orchestrate never block each other), atomic-write, and the budget machinery.

## 2. Data flow and state

**Start.** `orchestrate start --task <file> --target <dir>` validates the target
(§4c), creates the participant sessions (MiniMax: `createSession` → `mvs_…`; codex:
a logical session id), then appends one **`init`** ledger line carrying everything
known by then — task, target, budgets, participants **and** their session ids — and
writes the journal header. (Sessions are created *before* the init line, so the
init line can record their ids; no separate init bracket is needed.) `resume`
reconstructs the task from that init line.

**Loop (the orchestrator goes first each cycle — it is the router):**

```
1. Ask the orchestrator: feed the prior step's worker-summary (it remembers the
   rest — persistent session). Step 0: just the task.
   Orchestrator (LLM) → strict decision {action: run|done|escalate, worker, subtask, note}.
   Append a `decision` line (the validated decision + the call's token usage).
2a. action=run → append a `worker-started` line (worker W, subtask S);
    the worker runs in its OWN persistent session;
    bridge captures raw output (stored by reference) and builds the bounded
    worker-summary (§4a); append a `worker-result` line (summaryRef, status, usage).
    Raw output is NEVER shown to the orchestrator.
2b. action=done/escalate → append a `final` line, loop ends.
3. Budget: reserve before each LLM call, account after (§5); --yes gates spend.
```

Only **one pre-marker matters** — `worker-started` — because the worker call is the
only one with external side effects (it mutates the target). The orchestrator call
is side-effect-free: if it is interrupted, resume just re-asks (§ recovery), so it
needs no pre-marker, only the `decision` record written after it. The append-only
log is the durable record; `orch-state.json` is a small best-effort projection of
it (rewritten atomically for fast `status`), never the source of truth.

**State files:**
- `orch-ledger.jsonl` — **append-only log, the durable record.** One line per event:
  `{seq, step, kind, worker?, subtask?, summaryRef?, status?, usage?, payload?, ts}`,
  where `kind` ∈ `init | decision | worker-started | worker-result | final`. `init`
  carries task/target/budgets/participants+session-ids; `decision` carries the
  validated decision + call usage; `worker-result` carries summaryRef/status/usage.
  Never rewritten.
- `orch-state.json` — a small **best-effort projection** (`{status, step,
  spent, lastDecision}`) for fast `orchestrate status`; rebuildable from the log,
  so a stale/missing one is harmless.
- `orch-journal.md` — human-readable trail (decisions + notes + summaries),
  append-only, for "под ключ" observation.

**Runtime files (local, never committed or shipped).** All orchestrator runtime
state is local-only and must be git-ignored and documented in the runtime-files
contract: `orch-ledger.jsonl`, `orch-state.json`, `orch-journal.md`, `orch.lock`,
`orch-artifacts/` (raw worker output), and any per-task workspaces/worktrees. Add
the patterns to `.gitignore` (e.g. `/orch-*`, `/orch-artifacts/`) alongside the
existing duet runtime entries, and to `docs/RUNTIME_FILES.md`. `package.json` now
has a `files` whitelist (the audit's P3-2 was fixed), so these runtime files must
be **both** git-ignored **and** kept out of the `files` whitelist — the whitelist
default-excludes them, but do not add `orch-*` to it.

**Crash recovery (human-in-the-loop, one rule).** `orchestrate resume` replays the
log and continues. There is exactly **one ambiguous case**: a `worker-started` with
no `worker-result` — a target-mutating call that may or may not have run. The
bridge does **not** auto-rerun it; it **surfaces the situation to the human** (what
was attempted, the worktree's current `git status`) and lets them choose: redo as a
fresh step, mark it interrupted and move on, or abort. Every other tail just
continues — a `decision` with no `worker-started` proceeds to start that worker; an
interrupted (side-effect-free) orchestrator call is simply re-asked; a stale
`orch-state.json` is re-derived from the log. No formal state machine, no recovery
matrix — one append-only log and one human decision on the single ambiguous case.
(Provably-correct automatic recovery is deferred to the separate production
project; here the human is the recovery mechanism, per "human owns the risk".)

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

**Schema validation protects the parser, not the orchestrator's judgement.** A
malicious worker output → summary → could try to *steer* the LLM orchestrator
("ignore the task, run X / declare done"). The schema does not stop that. The real
defense is **capability-bounding at the bridge**, treating all summaries as
untrusted input:
- The orchestrator's only powers ARE the schema actions: pick a *registered*
  worker + write a sub-task, or done/escalate. Even a fully prompt-injected
  orchestrator cannot exceed that envelope — it cannot spawn arbitrary commands,
  reach unregistered workers, or raise its own privileges.
- The system prompt explicitly labels summaries as untrusted, instructs the
  orchestrator to weigh them against the original task, and forbids treating
  summary text as instructions.
- The worker-runner fences summary content (no structural/control tokens) when
  composing the orchestrator's input, so a summary cannot forge schema fields or
  prior-decision records.
- Hard caps (`maxSteps`/`maxTokens`, §5) bound the blast radius of a
  steered-into-looping orchestrator.

## 4. Worker I/O: summary contract, memory, workspace

### 4a. Worker-summary contract (the "bounded summaries" mechanism)

The "orchestrator never sees raw output" invariant is enforced at exactly one
chokepoint — the **worker-runner** — not left as a promise:

1. The worker-runner captures the worker's full raw output and writes it to disk
   (`orch-artifacts/<step>-<worker>.raw`), recording only a **reference** (path +
   sha + byte count) in the ledger. Raw output never enters the orchestrator path.
2. It then produces a **`worker-summary`** with a fixed schema and hard caps:
   ```json
   {
     "worker": "<id>", "step": <n>, "status": "ok | error | partial",
     "did": "<what was done, <= maxSummaryChars>",
     "artifacts": [{ "path": "...", "sha256": "...", "bytes": <n> }],
     "rawRef": { "path": "...", "sha256": "...", "bytes": <n> },
     "truncated": <bool>
   }
   ```
   - The worker is prompted to end its turn with a structured self-report; the
     worker-runner **validates and caps** it (≤ `maxSummaryChars`, drops unknown
     fields). If it is missing/malformed, the runner **synthesizes** a minimal
     summary deterministically (status + a capped head/tail of raw + the artifact
     list) — so a summary always exists and is always bounded.
   - `did` text is treated as **untrusted** (§3 capability-bounding) and is fenced
     when composed into the orchestrator's input.
3. Only this `worker-summary` is fed to the orchestrator. If it needs more detail,
   it routes another worker turn to inspect — it does not get raw bytes.

`maxSummaryChars` is a config knob (default in the low thousands), keeping the
orchestrator's accumulating context thin by construction.

### 4b. Executor memory (incl. codex statelessness)

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

The participant registry carries `memory: 'native-session' | 'workspace+reinject'`;
the worker-runner dispatches per strategy.

**Verify during implementation (not a blocker):** if the codex CLI supports native
resume/session, prefer it over the light re-injection layer; the
workspace+re-injection path works regardless.

### 4c. Codex workspace & apply contract

Isolation alone is not enough — the spec must say **how codex's changes reach the
real project**, or work silently strands in scratch.

The orchestrator takes an explicit **`--target <project-dir>`** (the real codebase
to act on). **Validation (realpath, both directions, closes audit P2-2):** after
`realpath`-resolving both, reject if `target === bridgeDir`, if `target` is inside
`bridgeDir`, OR if `bridgeDir` is inside `target` — any of which would let codex
reach the bridge's own sources. Reuse `realpathOrResolve` + `isPathInsideRoot`
from `lib/path-security` for the containment checks (both orientations). The
default, MVP contract:

- **Git target (recommended): a per-task `git worktree` of `--target` on a task
  branch.** Codex runs there in `workspace-write` and edits files; the worktree
  **persists across turns within the task** = codex's durable memory. **The bridge
  does NOT auto-commit per turn** (kept minimal): codex's changes simply accumulate
  in the worktree. For transparency, each codex turn captures `git status
  --porcelain` + a diff into the raw artifact (no commit, no spend). On
  `done`/`escalate` the human reviews the worktree/branch and **deliberately
  commits/merges or discards** — the "apply" is the human's action. No changes at a
  turn is fine (the worker-summary records a `no-op`).
- **Non-git target (fallback): copy-in.** Copy `--target` into a per-task workspace;
  codex edits there; on `done` the human reviews and applies. Explicit, never
  auto-applied.

The contract is explicit: the human knows exactly where results land (the task
worktree/branch) and applies them deliberately (risk-on-human). NOT in the MVP:
per-turn auto-commit, auto-merge, conflict resolution, multi-target, or applying
without human action. (Per-step commits / committed artifacts are a nicety for the
separate production version, not this tool.)

## 5. Termination and budget

Three termination paths:
1. Orchestrator decides `done` (with `summary`) → `status=done`.
2. Orchestrator decides `escalate` (with `reason`) → `status=escalated`.
3. **Hard caps (backstop)** even if the orchestrator loops without finishing:
   - `maxSteps` — cap on orchestrator decisions (a precise counter).
   - `maxTokens` — cumulative budget (orchestrator + all workers). Honest
     semantics, because real usage is only known *after* a call and estimates can
     be wrong: (1) **preflight estimate + reserve** before the next call; (2)
     **stop-before-next-call** if `spent + reserve` would exceed `maxTokens` — i.e.
     the budget gates *whether to start* the next call, never mid-call; (3)
     **post-fact accounting** updates `spent` from the call's actual reported usage
     (falling back to the estimate if the transport returns none). So the cap is a
     conservative stop-gate, not a guarantee of the exact final token count.
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
re-prompt→escalate); **worker-summary chokepoint** (raw output is stored by
reference and never appears in the orchestrator input; a missing/malformed
self-report is synthesized; the summary is capped at `maxSummaryChars`); log
shape (`decision` after the orchestrator call; `worker-started` before the worker
runs; `worker-result` after); the **one recovery rule** (a `worker-started`
without a `worker-result` is surfaced/marked interrupted, never auto-rerun; a
`decision` with no `worker-started` resumes the worker; a stale `orch-state.json`
is re-derived from the log); budget (`maxSteps` → graceful escalate; `maxTokens`
reserve→stop-before-call→post-fact accounting); codex re-injection block +
memory-strategy dispatch; `--target` realpath validation (equal / inside /
containing `bridgeDir` all rejected); worker failure → error-summary fed to
orchestrator (not a throw).

Integration tests (scripted, offline): happy path to `done` with a correct log;
escalate path; `maxSteps` backstop; budget backstop; resume after an interrupted
`worker-started` (the single ambiguous case → surfaced, not silently rerun); a
real `node:http` server standing in for the MiniMax transport (as in
`lib-mvs-client`/`lib-http-json`).

Guarantees: no real codex/MiniMax spawned in tests (codex via the fake hook;
MiniMax via a local server + scripted replies); everything under
`test:release`/`test:offline`; zero spend in CI. The additive design keeps the 130
existing duet tests green as the regression net. Each piece is built
RED→GREEN→refactor and its tests are mutation-meaningful (fail if the behavior is
removed), as with the verifier tests.

## Non-goals (the agreed minimum)

No correctness validators, no "done correctly" guarantees, no retry policies, no
per-worker sub-budgets, no parallel/fan-out workers, no upfront task decomposition
(routing is reactive), no user-defined pipeline yet (a possible later *mode*). The
human owns the risk.

**Explicitly NOT here (deferred to the separate production project):** provably-
correct automatic crash recovery (write-ahead intent/result/applied state machine,
multi-case recovery matrix), unattended/long-running operation, per-turn committed
artifacts. This tool stays simple: an append-only log and a human in the loop.

## Relationship to existing code & audit

- Reuses the post-Phase-2 `lib/` transports (`codex-exec`, `mvs-client`,
  `http-json`), the `lib/duet-lock` helper (with a separate `orch.lock`), atomic
  writes, `textSummary`/bounded packets, the `--yes`/budget machinery, and the
  `fakeModelReplyFromEnv` test hook.
- Retires by design the audit's worst class (P2-1/P2-3 "trust from journal text")
  via the strict decision schema **plus capability-bounding** (the schema bounds
  the parser; capability-bounding bounds a prompt-injected orchestrator); sidesteps
  P2-2 via the `--target ≠ bridgeDir` workspace contract; avoids P1-5/P1-8 by
  graceful caps and an honest dry-run.
- The duet relay and its in-flight bug fixes are left as-is; duet is retired only
  after the orchestrator is proven.

## Open items to settle during planning/implementation

- Which model is the orchestrator (default MiniMax/opencode session vs a
  configured model); confirm opencode supports a dedicated orchestrator session.
- Whether the codex CLI offers native resume (prefer it if so).
- Concrete defaults: `maxSummaryChars`, `maxSteps`, `maxTokens`, and the
  per-call token `reserve` heuristic.
