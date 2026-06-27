# Phase 4: Agent-to-Agent Workflow Plan

## Goal

Make Duet Relay support a real agent-to-agent workflow:

```text
Human starts a task with "let's go".
Codex works one turn and passes the baton.
MiniMax reviews, continues, or challenges the work and passes the baton back.
Agents repeat until verification passes, the task is done, or human escalation is needed.
```

The bridge remains thin. It preserves state, safety boundaries, derived packets,
handoffs, verification results, and explicit model-call gates. It must not
become a planner, workflow engine, or role configuration system.

## Principles

- Keep roles emergent. Do not hard-code that Codex implements and MiniMax
  reviews, or the reverse.
- Keep every token-spending action explicit. No hidden model calls.
- Keep local state inspectable. The human and both agents should be able to see
  who has the baton and what the next safe step is.
- Redact by default. Raw goal, handoff, journal, prompt, and verifier output
  require explicit `--raw`.
- Prefer deterministic verification over confidence language.
- Treat packets as projections, not runtime state. No `packet.json`, no separate
  packet journal, and no second state schema.
- Support the current reality: MiniMax can be invoked through the bridge; Codex
  continuation is still host-driven unless a stable Codex adapter is added later.

## Out Of Scope

- A full autonomous workflow engine.
- Permanent role definitions in config.
- Hidden or implicit token spending.
- Automatic Codex wake-up without a stable adapter.
- Project scaffolding generators.
- Long-running daemon behavior.
- `--force` overrides for token-spending model steps.

## Phase 4A: Local Workflow Protocol

Phase 4A is token-free. It clarifies baton state and introduces derived packet
views without adding a new mutable packet store.

### Phase 4A.1: `duet next`

Purpose: tell the current agent what the relay expects next.

Candidate commands:

```powershell
node .\bridge.mjs duet next
node .\bridge.mjs duet next --agent codex
node .\bridge.mjs duet next --agent minimax
node .\bridge.mjs duet next --raw
```

Default output is redacted JSON:

- relay status;
- baton holder;
- whether the requested agent is allowed to act now;
- iteration and max iteration;
- last handoff summary;
- last verifier summary, if present;
- warnings such as `done`, `human_escalation`, `wrong_baton`, or
  `max_iterations_reached`;
- static next-action hints.

Next-action hints must be a static source-level map. They must not be inferred
from journal content or model output. This prevents `duet next` from becoming a
planner.

`--raw` may include local goal, handoff, or journal text only when explicitly
requested.

### Phase 4A.2: Harden `duet pass`

Purpose: make the existing baton-advance command safe enough to serve as the
apply surface for future agent steps.

Do not add `duet packet apply` as a parallel command in Phase 4. Strengthen
`duet pass` instead.

Required hardening:

- validate `--from` owns the current baton unless existing `--force` is used for
  manual recovery;
- keep `--force` local-only and unavailable to `duet step`;
- validate handoff path, root containment, and maximum size;
- preserve terminal states `done` and `human_escalation`;
- append a compact journal entry;
- append a `duet-pass` ledger event;
- return redacted JSON by default;
- keep mutation under `duet.lock`.

`duet pass` remains the single state-advance primitive.

### Phase 4A.3: `duet packet export`

Purpose: create a compact read-side projection for MiniMax. The packet is
derived from `duet-state.json`, `duet-journal.md`, latest handoff, and latest
verification entries.

Candidate commands:

```powershell
node .\bridge.mjs duet packet export --agent minimax
node .\bridge.mjs duet packet export --agent minimax --format markdown --out .\duet-packet.local.md
node .\bridge.mjs duet packet export --agent minimax --raw --out .\duet-packet.local.md
```

Phase 4A only needs `--agent minimax`, because the first automated step is
MiniMax. Codex packet export is deferred until a Codex adapter exists or a real
use case appears.

Default packet contents:

- task goal summary;
- relay state summary;
- baton and expected receiver;
- latest handoff summary;
- recent journal summary;
- latest verifier summary;
- suggested next action as a static hint, not an instruction;
- allowed completion statuses: `running`, `done`, `human_escalation`.

Removed from Phase 4:

- changed-file summary. It would pull Git into the relay and should be a later
  opt-in feature such as `--with-git-status`.

Safety:

- Output is redacted by default.
- Raw file output requires a `.local.*` destination.
- Output paths must stay inside the bridge root.
- Packet files are transient outputs and should be ignored by git.
- Packet size is bounded by `duetPacketMaxChars`, default `60000`.
- `--max-packet-chars <n>` may lower the bound for a run; it may not exceed
  configured `maxLongPromptChars`.
- Truncation must be visible with a marker, not silent.

## Phase 4B: MiniMax Step

Phase 4B adds one explicit token-spending command for the MiniMax side.

### Scope

The first shipped version is review-only only. There is no continuation mode,
no arbitrary `--mode`, and no `--force` override for wrong-baton model calls.

Candidate commands:

```powershell
node .\bridge.mjs duet step --agent minimax --dry-run
node .\bridge.mjs duet step --agent minimax --yes
```

`--dry-run` is token-free. `--yes` authorizes the MiniMax model call.

### Exact Model Path

`duet step --agent minimax --yes` reuses the existing `ask --mode review-only`
request path. If the implementation needs refactoring, extract shared internal
helpers from `askCommand`; do not create a fourth MiniMax call path and do not
use `mvs-send` for Phase 4B.

The step must preserve existing routing, deny-session, token budget, output cap,
ledger, and optimization behavior from `ask`.

### Phase 4B.1: Dry Run

Purpose: prove packet assembly and token estimates before any live model call.

Behavior:

1. Read relay state.
2. Fail if status is not `running`.
3. Fail if `maxIterations` has been reached.
4. Fail if baton is not held by MiniMax.
5. Export the MiniMax packet in memory.
6. Print redacted JSON with:
   - packet char count;
   - max packet chars;
   - estimated input tokens;
   - configured route/model;
   - first 200-character redacted preview;
   - whether a live call would be allowed.
7. Do not write model handoff files.
8. Do not call MiniMax.
9. Do not advance baton.

### Phase 4B.2: Real MiniMax Step

Behavior:

1. Acquire an async-capable Duet lock before reading state.
2. Keep single-writer protection until state is either advanced or a pending
   handoff failure is reported.
3. Refresh or heartbeat the lock if the model call approaches the existing
   10-minute stale threshold.
4. Fail if status is not `running`.
5. Fail if `maxIterations` has been reached.
6. Fail if baton is not held by MiniMax.
7. Build a bounded MiniMax packet.
8. Send the packet through the internal equivalent of
   `ask --mode review-only --yes`.
9. Save MiniMax's answer as `.duet-step-minimax-<timestamp>.pending.local.md`.
10. Apply it through the hardened `duet pass` logic.
11. On success, rename or record the pending handoff as applied, advance baton,
    and return redacted JSON.
12. On apply failure, do not advance baton. Keep the `.pending.local.md` file
    and surface its path in the JSON error so the user can recover manually with
    `duet pass`.

Safety:

- `--yes` authorizes only the model call. State advancement is still governed by
  hardened `duet pass` validation.
- No `--force` for `duet step`.
- Denied sessions must block step because the command reuses the existing `ask`
  path.
- Packet input is bounded by `duetPacketMaxChars` and existing
  `maxInputTokens`.
- Output is bounded by existing `outputCapTokens`.
- Step output redacts MiniMax's answer unless `--raw` is explicitly passed.
- Do not auto-run local commands suggested by MiniMax.
- Do not auto-commit, push, delete, or mutate files beyond Duet runtime files
  and pending/applied local handoff files.
- Append a `duet-step` ledger event with timestamp, agent, model, input chars,
  output chars, finish reason, and status.

## Phase 4C: Codex Adapter, Deferred

Codex continuation is currently host-driven: the user or current Codex session
continues the work by reading `duet next`.

Only add a Codex adapter if there is a stable local invocation surface for a
separate Codex session.

Candidate future command:

```powershell
node .\bridge.mjs duet step --agent codex --dry-run
```

Do not implement token-spending Codex automation until the invocation model is
clear and reviewable.

## Verification Loop

Agents should use deterministic verifiers when possible:

```powershell
node .\bridge.mjs duet verify --verifier .\verify.mjs --record --agent codex
node .\bridge.mjs duet verify --verifier .\verify.mjs --record --agent minimax
```

`duet next` and packet exports should show the latest verifier result.

Verifier results do not automatically block baton advance in Phase 4. The agent
holding the baton decides whether to continue, pass, mark `done`, or escalate.
This keeps the bridge thin and avoids turning it into a policy engine.

A passing verifier may justify `done`; a failing verifier should normally
produce another baton pass or human escalation.

## Live Smoke Scenario

Use a fresh ignored directory and a simple browser task:

```text
Build a browser Tetris game in this empty directory. It should open in a browser
and pass the provided verifier. let's go
```

Expected flow:

1. Codex initializes relay and performs the first local work turn.
2. Codex passes baton to MiniMax with `duet pass`.
3. `duet step --agent minimax --dry-run` confirms packet and token estimate.
4. `duet step --agent minimax --yes` runs one MiniMax review-only turn.
5. Codex resumes from `duet next`.
6. Codex runs `duet verify`.
7. Agents continue until `done` or `human_escalation`.

The smoke proves:

- baton state is understandable;
- packets carry enough context;
- MiniMax can continue without the human saying "approved, continue";
- verification result survives in the journal;
- the workflow stops cleanly.

## Acceptance Criteria

Phase 4A:

- AC1: `duet next` from running state with baton `codex` returns
  `status=running`, `baton=codex`, `allowedToAct=true`, and no warnings for
  `--agent codex`.
- AC2: `duet next --agent minimax` when baton is `codex` returns
  `allowedToAct=false`, `warning=wrong_baton`, and a static recovery hint.
- AC3: `duet next` for `done` and `human_escalation` returns terminal status
  and does not suggest a model call.
- AC4: `duet packet export --agent minimax` redacts secrets by default.
- AC5: `duet packet export --raw --out` rejects tracked-looking paths and
  accepts `.local.*` paths.
- AC6: `duet packet export` rejects outside-root output paths.
- AC7: oversized packet content is truncated with a visible marker.
- AC8: hardened `duet pass` validates baton, path, size, status enum, and
  terminal states.

Phase 4B:

- AC9: `duet step --agent minimax` without `--yes` and without `--dry-run`
  exits non-zero with a clear message and does not call the model.
- AC10: `duet step --agent minimax --yes` with baton `codex` exits non-zero and
  does not call the model.
- AC11: `duet step --agent minimax --dry-run` spends no tokens, writes no model
  handoff, and appends no model-call ledger entry.
- AC12: a successful real step advances iteration by exactly 1, flips baton, and
  writes journal and ledger entries.
- AC13: a failed apply leaves `duet-state.json` byte-identical to pre-step and
  writes a `.pending.local.md` handoff path for recovery.
- AC14: step output JSON redacts the MiniMax answer unless `--raw` is passed.
- AC15: two concurrent `duet step` invocations cannot both advance state.

## Tests

Offline tests:

- `duet next` without state, with `running`, with `done`, and with
  `human_escalation`.
- `duet next --agent <agent>` reports allowed/disallowed baton status.
- `duet packet export` redacts by default.
- `duet packet export --raw --out` requires a local ignored-looking path.
- `duet packet export` rejects outside-root output paths.
- Packet truncation uses a visible marker.
- `duet pass` validates baton ownership, handoff path, handoff size, status
  enum, terminal state, and lock behavior.
- `duet step --agent minimax --dry-run` spends no tokens and writes no model
  handoff.
- Wrong-baton `duet step --agent minimax --yes` fails before any model call.
- Concurrency: two parallel `duet step` invocations cannot both win.
- Redaction regression: a secret in the goal does not appear in default
  `duet next`, `duet packet export`, or `duet step` output.
- Windows path coverage: spaces, case-folding, and outside-root paths for
  `--out` and `--handoff`.

Live/manual tests:

- `duet step --agent minimax --yes` on a compact relay.
- Tetris smoke with a real MiniMax turn.

Automated tests must not spend tokens.

## Documentation Updates

Update:

- `README.md`;
- `docs/COMMANDS.md`;
- `docs/DUET_RELAY.md`;
- `docs/LETS_GO.md`;
- `docs/DUET_TETRIS_BROWSER_TEST.md`;
- `docs/TESTING.md`;
- `skills/bridge/SKILL.md`;
- `skills/codex-bridge/SKILL.md`;
- `prompts/bridge.md`.

## Risks

- Hidden token spending: mitigate with explicit `--yes`, no `--force` in step,
  and dry-run-first docs.
- Prompt leakage: redact packets by default and limit raw output paths.
- Workflow creep: keep commands generic; no hard-coded task templates, computed
  plans, or permanent roles.
- Wrong baton mutation: validate agent ownership before applying handoffs.
- Mid-step failure: keep pending handoff, do not advance baton, and report the
  recovery path.
- Step race: use async Duet locking and test concurrent invocations.
- Runtime pollution: keep packet and handoff files ignored or `.local.*`.
- MiniMax answer parsing ambiguity: first version stores the answer as a handoff
  and uses explicit status flags rather than parsing complex structured output.
- Codex automation ambiguity: defer until a reliable adapter exists.

## Recommended Implementation Order

1. Implement `duet next`.
2. Harden `duet pass`.
3. Implement shared packet projection formatter.
4. Implement `duet packet export --agent minimax`.
5. Add docs and offline tests for Phase 4A.
6. Implement `duet step --agent minimax --dry-run`.
7. Review Phase 4A and 4B.1 with MiniMax.
8. Implement `duet step --agent minimax --yes` through the existing
   `ask --mode review-only` path.
9. Run live smoke.
10. Commit and push.

## Progress

- Phase 4A.1 `duet next`: implemented.
- Phase 4A.2 `duet pass` hardening: implemented for handoff root containment,
  regular-file validation, size validation, and tests.
- Phase 4A.3 `duet packet export --agent minimax`: implemented as a derived
  projection with redacted defaults, raw `.local.*` output guard, path safety,
  packet bounds, visible truncation, docs, and tests.
- Phase 4B.1 `duet step --agent minimax --dry-run`: implemented with
  status/baton/max-iteration validation, route/model and token estimate,
  redacted default output, raw prompt opt-in, docs, and tests.
- Phase 4B.2 `duet step --agent minimax --yes`: implemented for one
  review-only MiniMax turn with async Duet lock, pending/applied local handoff
  files, hardened `duet pass` application, redacted default output, fake-model
  offline tests, and pending recovery on apply failure.
