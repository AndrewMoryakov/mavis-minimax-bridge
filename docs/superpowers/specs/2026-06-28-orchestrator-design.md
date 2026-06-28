# Orchestrator Layer — Design Spec

Date: 2026-06-28. Status: **approved for implementation planning — design only, not
yet implemented.** Two review passes folded in: (1) write-ahead ledger, separate
compact state, worker-summary chokepoint, codex workspace/apply contract, honest
budget semantics, dedicated `orch.lock`, capability-bounding against summary-borne
prompt injection; (2) init-through-WAL, a crash-recovery matrix for unclosed WAL
steps, bridge-commits-per-codex-turn, realpath target validation (both
directions), and a local/git-ignored runtime-files contract.

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
| orchestrator state | `orch-ledger.jsonl` (append-only WAL, source of truth) + `orch-state.json` (compact projection) + `orch-journal.md` (human trail); guarded by a **dedicated `orch.lock`** via the `lib/duet-lock` helper | `lib/duet-lock` helper, atomic write |
| `bridge.mjs` | CLI dispatch for `orchestrate start/status/resume` | all of the above |

Boundary with duet: **zero** — separate commands and separate state files
(`orch-*`). Only the low-level *primitives* are shared: the transports, the
lock **helper** (`lib/duet-lock.mjs`, but a separate `orch.lock` file so duet and
orchestrate never block each other), atomic-write, and the budget machinery.

## 2. Data flow and state

**Start (also through the WAL).** `orchestrate start --task <file> --target <dir>`
runs a write-ahead init sequence, ordered so each record holds only what is known
at that point (session ids exist only *after* creation):

```
init-intent (task, target, budgets, planned participants — NO session ids yet)
  → create sessions (MiniMax: createSession → mvs_…; codex: a logical session id)
  → session-create-result (participants + their session ids)
  → write journal header → project initial state → init-applied
```

So `resume` reconstructs the whole task — task, target, budgets, participants,
session ids — from the ledger alone, with no reliance on `orch-state.json` having
survived. A crash *after* `init-intent` but *before* `session-create-result` means
no usable sessions were recorded → resume re-runs init cleanly. A crash after
`session-create-result` but before `init-applied` may leave orphan provider
sessions; because their ids did reach the ledger, resume can reuse or explicitly
abandon them rather than leaking silently.

**Loop (the orchestrator goes first each cycle — it is the router):**

```
1. Append DECISION-INTENT (about to ask the orchestrator).
2. Bridge → orchestrator: the new result-summary of the prior step
   (the orchestrator remembers the rest — persistent session).
   Step 0: just the task (the ledger holds only the init records, no step results yet).
   Orchestrator (LLM) → strict decision: {action: run|done|escalate, worker, subtask, note}.
   Append DECISION-RESULT (the validated decision + the call's token usage).
3a. action=run → append WORKER-INTENT (run worker W with subtask S);
    worker-runner gives the worker {subtask + goal-as-background};
    the worker runs in its OWN persistent session;
    bridge captures raw output, stores it by reference, builds a bounded
    worker-summary (§4a); append WORKER-RESULT + journal artifact;
    project compact state; mark the worker intent APPLIED.
    Raw output is NEVER shown to the orchestrator.
3b. action=done/escalate → finalize (terminal applied record), loop ends.
4. Budget reserved before EACH LLM call (orchestrator and worker), accounted after (§5);
   --yes gates spend.
```

**Write-ahead order (per step):** BOTH spend-bearing calls are bracketed —
`decision-intent → (orchestrator call) → decision-result → worker-intent →
(worker runs) → worker-result → journal/state projection → applied`. The
append-only ledger is written *before* each spending call and *before* the compact
state, so neither the orchestrator's decision/spend nor the worker's can be lost in
a crash without a durable trace. (This supersedes the simpler duet rule "state
before journal", which fit duet's no-spend model; the orchestrator spends tokens
per step, so it needs a real write-ahead log.)

**Key asymmetry for recovery:** the orchestrator call has **no external side
effects** (it only decides + spends tokens), so on an ambiguous crash it is **safe
to re-ask** (accounting the lost spend). A worker call **does** mutate the target
(files), so it is **never auto-rerun**. This distinction drives the recovery matrix.

**State files:**
- `orch-ledger.jsonl` — **append-only WAL, the durable source of truth.** One line
  per event: `{seq, step, kind, worker?, subtask?, summaryRef?, status?, usage?,
  payload?, ts}`, where `kind` ∈ `init-intent | session-create-result | init-applied
  | decision-intent | decision-result | worker-intent | worker-result | applied`.
  `init-intent` carries task/target/budgets/planned-participants in `payload`;
  `session-create-result` carries participants + session ids; `decision-result`
  carries the validated decision + call usage. Never rewritten.
- `orch-state.json` — a **compact projection** derived from the ledger:
  `{ task, status, step, participants:[{id,kind,transport,sessionId,memory}],
  budget:{maxSteps,maxTokens,spent}, lastDecision }`. Small, rewritten atomically;
  holds **no** per-step history (that lives in the ledger).
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

**Durability invariant:** the `orch-ledger.jsonl` WAL is the source of truth; the
compact `orch-state.json` and the orchestrator's live LLM session are both
**projections** of it. After a crash, `orchestrate resume` rebuilds both the state
and the orchestrator's context by replaying the ledger. `orchestrate status` reads
the same projection.

**Crash recovery (resume).** Resume replays the WAL and reconciles the *tail* — the
records after the last cleanly-closed step. Guiding principle: **never auto-rerun
an ambiguous spent call; complete what is already durable; surface the unknown to
the orchestrator.**

| Ledger tail | Meaning | Resume action |
|-------------|---------|---------------|
| `init-intent`, no `session-create-result` | sessions not durably created; **no spend** | re-run init cleanly |
| `session-create-result`, no `init-applied` | sessions exist (ids recorded) but init not closed | reuse the recorded sessions (or abandon them explicitly), then project state + `init-applied` |
| `decision-intent`, no `decision-result` | the orchestrator call **may have spent tokens**, decision unknown — but it has **no external side effects** | **safe to re-ask** the orchestrator; account the interrupted call's spend as lost/unknown |
| `decision-result`, no `worker-intent` | a decision is durable but the worker wasn't started yet | proceed: start the worker per the recorded decision (or finalize, if done/escalate) — no re-ask |
| `worker-intent`, no `worker-result` | the worker call **may have run, spent tokens, and mutated the target** | **do NOT re-run.** Append `worker-result{status:'interrupted'}` + `applied`; feed it as the step summary so the **orchestrator decides** (redo as a fresh step, or move on) |
| `worker-result`, no `applied` | work is durable; only the projection/close didn't finish | re-project state and append `applied` (idempotent) — **no re-run, no extra spend** |
| journal/artifact ahead of `state` | `state` is only a projection | re-derive `state` from the ledger (the ledger, not the journal, is authority) |

Every spend-bearing call (orchestrator **and** worker) is bracketed, so a crash
leaves at most one call ambiguous. The side-effect-free orchestrator call is
safely re-asked; the target-mutating worker call is never auto-rerun and is instead
surfaced to the orchestrator.

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
  branch.** Codex runs there in `workspace-write` and just edits files. **The
  bridge — not codex — commits the worktree after each codex turn** (once the
  worker-summary is recorded), so each step is one reviewable commit and the
  commit sha becomes the step's artifact reference in the ledger. This gives
  (a) durable per-turn memory (the committed worktree persists across turns),
  (b) isolation from both the bridge and the user's working tree, and (c) a clean
  apply/review/rollback path: the human inspects the branch and merges or discards
  — the "apply" is the merge, no bespoke patch step. The branch/worktree is
  recorded in the ledger and reported by `orchestrate status`. (Alternative
  considered and rejected for the MVP: a dirty no-auto-commit worktree — it loses
  per-step artifacts/rollback granularity and makes "real commits" untrue.)
- **Non-git target (fallback): copy-in + patch-export.** Copy `--target` into a
  per-task workspace, codex edits there, and on `done` the orchestrator emits a
  unified diff for the human to apply. Explicit, never auto-applied.

**Bridge auto-commit edge cases (must be defined, else "commit after each turn" is
underspecified):**
- **No changes** (`git status --porcelain` empty) → no commit; the worker-summary
  records artifact `no-op` (a valid outcome — the orchestrator may have asked codex
  to inspect, not edit).
- **Commit fails** (hook, lock, disk) → the worker-summary is `status: error` with
  the git stderr; no `applied`-as-success — it becomes an error the orchestrator
  routes on (per §5 worker-failure handling).
- **Transparency** → `git status --porcelain` is captured into the raw artifact for
  every codex turn, committed or not.
- **Path discipline** → the bridge stages with an explicit pathspec scoped to the
  worktree and refuses to commit changes to `.git/` internals; codex is already
  sandboxed to the worktree (validated `--target`), so this is a cheap belt-and-
  suspenders, not the primary boundary. A finer path allow/deny list is post-MVP.

Either way the contract is explicit: the human knows exactly where results land
and applies/merges them deliberately (risk-on-human, per the non-goals). What is
NOT in the MVP: auto-merge, conflict resolution, multi-target, or applying without
human action.

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
self-report is synthesized; the summary is capped at `maxSummaryChars`); WAL
ordering (both `decision-*` and `worker-*` intents appended before their spending
call; state is a projection rebuilt from the ledger; applied closes the step);
**crash-recovery matrix** (each tail row: `decision-intent`-only → safe re-ask;
`decision-result`-only → proceed; `worker-intent`-only → interrupted, not rerun;
`worker-result`-only → idempotent close; `init-intent`-only → clean re-init);
budget (`maxSteps` → graceful escalate; `maxTokens` reserve→stop-before-call→
post-fact accounting); codex re-injection block + memory-strategy dispatch;
`--target` realpath validation (equal / inside / containing `bridgeDir` all
rejected); auto-commit edge cases (no-op on no changes, error on commit failure);
worker failure → error-summary fed to orchestrator (not a throw).

Integration tests (scripted, offline): happy path to `done` with a correct
ledger; escalate path; `maxSteps` backstop; budget backstop; resume from each
ambiguous WAL tail (interrupt → **replay `orch-ledger.jsonl`** → correct recovery
action); a real `node:http` server standing in for the MiniMax transport (as in
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
