# Codex Adapter Plan Review

Date: 2026-06-27

Status: Phase 5A research complete; Phase 5B adapter step implemented.

Related review:

- `docs/CODEX_ADAPTER_MINIMAX_REVIEW.md`
- `docs/CODEX_ADAPTER_RESEARCH.md`

## Context

Phase 4B.2 proved the MiniMax side of Duet Relay:

- Codex can pass baton to MiniMax.
- `duet step --agent minimax --yes` can run one live review-only MiniMax turn.
- The bridge can write a pending handoff, apply it through hardened `duet pass`,
  and return baton to Codex.
- A live Tetris smoke completed with final verifier `ok`.

The remaining gap is the Codex side. Between MiniMax rounds, the current Codex
session still has to stay alive and act as the Codex executor. That removes the
need for human "continue" messages during one active session, but it is not a
fully autonomous agent-to-agent workflow.

## Revised Verdict

We need a Codex adapter before implementing a real autonomous `duet loop`.

However, implementation must not proceed past Phase 5A until a stable,
non-interactive Codex invocation surface is proven. If no stable invocation
surface exists, the adapter must be deferred and the loop must stop with
`codex_action_required`.

## Target State

One human approval should start a bounded autonomous run:

```text
human approves once
-> Codex step
-> MiniMax step
-> Codex step
-> MiniMax step
-> ...
-> done / human_escalation / error / budget stop
```

The human should receive the final report, not approve every round.

## Phase 5A: Research Codex Invocation

Implementation status: complete.

Outcome: `supported_and_stable`; see `docs/CODEX_ADAPTER_RESEARCH.md`.

Goal: find and prove a stable non-interactive way to run a separate Codex
executor.

Required research commands:

```powershell
where.exe codex
codex --help
codex --version
```

Required probes:

- tiny non-interactive Codex task in an ignored throwaway directory;
- stdout/result capture shape;
- exit-code semantics;
- workspace-root control;
- timeout behavior;
- token-spend visibility;
- whether skills/AGENTS instructions are loaded;
- whether the current interactive Codex session is disturbed;
- concurrency probe with two simultaneous dry-run Codex invocations.

Research outcomes:

- `supported_and_stable`: proceed to Phase 5B.
- `possible_but_risky`: stop and document risks; do not implement Phase 5B/5D
  without explicit follow-up approval.
- `unavailable`: stop; adapter is deferred; loop may only support MiniMax and
  return `codex_action_required`.

Expected output:

```text
docs/CODEX_ADAPTER_RESEARCH.md
```

Historical hard gate before Phase 5A completed:

- Do not implement `duet step --agent codex --yes`.
- Do not implement `duet loop`.
- Do not write adapter code until Phase 5A returns `supported_and_stable` or
  the user explicitly accepts a documented risky path.

Current gate after Phase 5A:

- `duet step --agent codex --dry-run` and `duet step --agent codex --yes` may
  exist behind explicit `--yes`.
- Do not implement `duet loop` yet.
- Do not run real Codex or MiniMax live steps without explicit token-spending
  approval.

## Phase 5B: Codex Step Contract

Implementation status: complete for one explicit Codex step.

The Codex adapter should mirror MiniMax step semantics.

Candidate commands:

```powershell
node .\bridge.mjs duet step --agent codex --dry-run
node .\bridge.mjs duet step --agent codex --yes
```

Input packet should include:

- relay goal summary;
- current state;
- last handoff;
- journal tail;
- latest verifier result;
- allowed statuses;
- workspace and safety limits;
- exact expected handoff format.

Secret handling:

- Redact secrets before packet assembly, not only before stdout.
- Raw packet artifacts require explicit `--raw`.
- Raw packet artifacts must use `.local.*` paths inside the bridge root or a
  canonical approved workspace.
- Default output must not expose raw goal, handoff, journal, verifier stderr, or
  model answer text.

Expected Codex output:

```text
Status: running|done|human_escalation

Summary...
Changed files...
Verifier result...
Next handoff...
```

Bridge responsibilities:

- build bounded packet;
- invoke Codex adapter;
- save `.duet-step-codex-*.pending.local.md`;
- apply through hardened `duet pass`;
- redact output by default;
- keep pending handoff on apply failure;
- record ledger/outbox events;
- verify that baton and iteration advanced as expected.

Implemented notes:

- Codex live step uses `codex exec` with `--ignore-user-config`, `--ephemeral`,
  explicit `--cd`, `workspace-write`, `--json`, and `--output-last-message`.
- The bridge holds the async Duet lock across packet assembly, adapter
  execution, and `duet pass` apply.
- `codexCli` and `codexStepTimeoutSec` are configurable.
- Windows timeout cleanup uses `taskkill /T /F` for the spawned process tree.
- Offline tests use the existing gated fake reply path and do not spend tokens.

## Phase 5C: Safety Model

Implementation status: started. `duet loop --dry-run` exists as a token-free
preflight for loop limits, next-agent preview, token estimate, verifier config,
and stop reasons. `duet loop --yes` is still not implemented.

Required gates:

- `--dry-run` is local-only and token-free.
- `--yes` is required for token-spending Codex execution.
- No `--force` for step commands.
- Async Duet lock is held across adapter execution and apply.
- Codex adapter workspace root must be canonicalized.
- Prefer a separate throwaway worktree or isolated workspace for spawned Codex.
- Max wall-clock is enforced.
- Idle timeout is enforced.
- Per-step and per-run token budgets are enforced.
- Max rounds and max Codex/MiniMax steps are enforced by loop.
- No git commit or push inside adapter-controlled steps.
- No destructive commands unless explicitly enabled by future policy.
- Raw packet/output requires `--raw`.
- Apply failure keeps pending handoff and does not advance baton.

File-write boundaries:

- Block writes to `.git`, `.env`, `node_modules`, bridge runtime secrets, and
  binary/large files by default.
- Canonicalize all paths and block symlink/hardlink escapes.
- Prefer an allowlist for gauntlet workspaces.

Verifier execution:

- timeout required;
- no shell by default;
- minimal environment;
- restricted filesystem scope where possible;
- no network by default or explicit allowlist;
- stdout/stderr redacted by default.

Transcript integrity:

- final transcript should be append-only JSONL;
- each event should include previous-event hash;
- final report should include transcript hash;
- ledger event order must be monotonic and auditable.

Human escalation:

- `human_escalation` must include a reason and suggested human decision;
- loop stops immediately;
- final report must surface escalation reason and pending handoff path;
- future resume protocol should support a human-edited handoff and
  `--resume-from <id>`.

## Phase 5D: Duet Loop

Do not implement until Codex invocation and one-step Codex adapter are proven.

Current status: not implemented.

After both adapters exist, add:

```powershell
node .\bridge.mjs duet loop --yes --max-rounds 8 --max-minimax-steps 4 --max-codex-steps 4 --max-tokens 60000 --verifier .\verify.mjs
```

Loop behavior:

1. Read `duet next`.
2. If baton is `codex`, run Codex adapter.
3. If baton is `minimax`, run MiniMax adapter.
4. Run verifier when configured.
5. Record compact verifier result.
6. Check baton, status, and iteration advanced as expected.
7. Stop on `done`, `human_escalation`, max rounds, token budget, adapter
   failure, apply failure, idle timeout, or verifier failure threshold.
8. Export a final transcript/report.

Stop thresholds:

- repeated verifier failure means two consecutive failures with the same error
  signature;
- baton did not advance after a successful step means abort;
- identical handoff hash repeated twice means abort as stuck loop;
- max wall-clock and idle timeout are hard stops.

Final report must include:

- final relay status;
- total rounds;
- Codex and MiniMax step counts;
- total token usage where available;
- verifier history;
- pending/applied handoff counts;
- transcript hash;
- warnings and recovery instructions.

## Phase 5E: Long Smoke Scenario

Use a long Tetris Gauntlet instead of a single live step.

Minimum acceptance:

- at least 6 baton events;
- at least 2 MiniMax live steps;
- at least 2 Codex adapter steps;
- at least 3 verifier runs;
- handoff schema valid for every transition;
- each side consumes the previous handoff in a later response or file change;
- ledger/outbox events are monotonic and complete;
- verifier covers at least two independent invariants;
- final relay status `done`;
- no pending handoffs left;
- final verifier `ok`;
- transcript hash recorded in final report;
- transcript proves Codex and MiniMax both contributed.

Candidate structure:

```text
examples/duet-tetris-gauntlet/
  TASK.md
  verify.mjs
  phases.json
```

Ignored live workspace:

```text
live-smoke-tetris-gauntlet-YYYYMMDD/
```

Verifier should be phase-aware and validate both product state and relay state.

## Main Risk

The plan depends on a stable Codex invocation surface. If Codex cannot be
started non-interactively from the bridge, Phase 5D must remain partial:

```text
minimax can run automatically
codex returns codex_action_required
```

That would still be useful, but it would not satisfy the "no human between
rounds" goal.

## Recommended Next Step

Run Phase 5A only and write `docs/CODEX_ADAPTER_RESEARCH.md`.

Do not implement `duet loop` until the Codex invocation surface is proven or
the user explicitly accepts a documented risky path.
