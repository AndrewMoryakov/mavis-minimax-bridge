# Claude Code Adapter Plan

## Decision

Add Claude Code as a third Duet Relay agent, not as a full GUI/backend bridge.

Long term, the bridge should support:

```text
Codex <-> Claude Code
Codex <-> MiniMax
MiniMax <-> Claude Code
Codex <-> MiniMax <-> Claude Code
```

The first implementation must not jump directly to the full matrix. The current
Duet Relay is structurally two-agent: state validation, baton rotation, loop
limits, loop counters, and reports are built around `codex|minimax`.

The safe implementation order is:

1. Add a Claude Code adapter and diagnostics.
2. Add a single Claude duet step while keeping existing two-agent behavior
   intact.
3. Refactor Duet Relay to a real participant registry.
4. Enable multi-agent routes such as `codex,claude` and
   `codex,minimax,claude`.

The target user-facing surface after the registry refactor is:

```powershell
node .\bridge.mjs duet start --agents codex,claude --goal .\goal.local.md
node .\bridge.mjs duet pass --from codex --to claude --handoff .\handoff.local.md
node .\bridge.mjs duet step --agent claude --dry-run
node .\bridge.mjs duet step --agent claude --yes
node .\bridge.mjs duet loop --dry-run
node .\bridge.mjs duet loop --yes
node .\bridge.mjs duet report
```

## Source Research

The existing `CodeAgentMonitor` repository has useful Claude Code integration
research at:

```text
O:\user files\Projects\CodeAgentMonitor\
```

Most relevant files:

- `src-tauri/src/claude_bridge/process.rs`
- `src-tauri/src/claude_bridge/event_mapper.rs`
- `src-tauri/src/claude_bridge/types.rs`
- `src-tauri/src/claude_bridge/item_tracker.rs`
- `src-tauri/src/claude_bridge/history.rs`
- `docs/claude-cli-stream-json-protocol.md`

Portable ideas:

- Use Claude Code stream-json mode.
- Parse stdout as newline-delimited JSON.
- Collect `result`, usage, cost, model, and `session_id`.
- Track process liveness and report clear failure state.
- Classify tool activity into command/file/read categories.
- Keep approvals and user-input requests distinct from normal text output.

Do not copy the full Codex app-server compatibility layer into this bridge.
That is larger than the current local supervised Duet Relay needs.

## Claude CLI Shape

The researched persistent protocol uses:

```powershell
claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages
```

For the first bridge MVP, prefer a bounded per-step invocation unless persistent
state becomes necessary.

Important boundary: a bounded invocation is safe only if interactive tool
prompts cannot hang the process. Claude Code can emit `control_request` events
for tool permissions and `AskUserQuestion`; the CLI can block until it receives
a matching `control_response`.

Therefore the MVP must choose one of these modes explicitly:

- **MVP-A: stateless no-tools runner.** Disable or deny interactive tool paths,
  treat any `control_request` as a diagnostic failure, and rely on the Duet
  packet for context. This is the recommended first implementation.
- **MVP-B: bidirectional runner.** Keep stdin open, maintain pending control
  requests, send `control_response`, support interrupt, and handle
  `AskUserQuestion`. This is more powerful but belongs after the skeleton.

This MVP implements MVP-A only. MVP-B is a follow-up after the stateless runner,
manual Claude step, and participant registry are proven.

Preserve `session_id` from Claude results for future resume support, but do not
ship `--resume` as a user-facing config until lifecycle ownership is defined.

Useful flags to support by config:

- `--model`
- `--max-turns`
- `--max-budget-usd`
- `--permission-mode`
- `--allowedTools`
- `--disallowedTools`
- `--resume` (deferred until session lifecycle is designed)

## Execution Roadmap

Use these stages as the actual delivery order. Each stage should be a small
reviewable change. Do not start a later stage until the previous stage's
definition of done is met.

### Stage 0: Baseline And Fixtures

Goal: make future Claude work measurable without touching live Claude Code.

Files:

- `docs/CLAUDE_CODE_ADAPTER_PLAN.md`
- `tests/fixtures/` or `tests/helpers/`
- `tests/lib-claude-code.test.mjs` (new, can start empty or with resolver tests)

Work:

- Add representative Claude stream-json fixture lines.
- Add a fake Claude CLI script that can emit success, error, stderr, malformed
  JSON, timeout, and control-request scenarios.
- Keep the real `claude` command out of CI tests.

Done when:

- Fake CLI can be invoked by tests.
- `npm run test:release` remains green.
- No bridge runtime behavior changes.

### Stage 1: Claude Resolver And Doctor-Only Diagnostics

Goal: detect Claude Code safely, especially on Windows.

Files:

- `lib/claude-code.mjs` (new)
- `lib/config-core.mjs`
- `bridge.mjs`
- `tests/lib-claude-code.test.mjs`
- `tests/bridge-cli.test.mjs`

Work:

- Add config fields for Claude, but do not run model turns.
- Implement `resolveClaudeCli()`.
- Detect executable, `.cmd/.bat`, npm shim, PowerShell function/alias, and
  missing command.
- On Windows, explicitly distinguish PowerShell functions/aliases from
  spawnable binaries. Function/alias detection should produce a diagnostic or a
  resolved underlying executable, not a path that `spawn()` cannot run.
- Extend `doctor` with Claude availability and remediation.

Done when:

- `doctor` reports Claude status without spending tokens.
- Config validation accepts Claude keys.
- Tests cover missing CLI, configured path, path with spaces, `.cmd`, and
  PowerShell function detection.

### Stage 2: Stateless No-Tools Claude Runner

Goal: run one bounded Claude Code prompt safely outside Duet.

Files:

- `lib/claude-code.mjs`
- `tests/lib-claude-code.test.mjs`

Work:

- Build Claude argv for MVP-A.
- Parse stream-json stdout.
- Collect answer, usage, cost, model, result subtype, stop reason, duration,
  permission denials, model usage, and rate-limit events.
- Fail fast on `control_request` instead of hanging.
- Enforce timeout and terminate the process tree.

Done when:

- Fake success returns a normalized result.
- Fake `control_request` returns a clear failure result.
- Timeout, non-zero exit, malformed JSON, stderr, and budget/max-turn errors are
  covered by tests.
- Still no Duet behavior changes.

### Stage 3: Claude Manual Step Dry-Run

Goal: show what a Claude duet step would do, without calling Claude.

Files:

- `bridge.mjs`
- `lib/claude-code.mjs`
- `tests/bridge-cli.test.mjs`

Work:

- Add the minimal manual-participant plumbing needed for
  `duet step --agent claude --dry-run`:
  - `requireDuetAgent()` accepts `claude`.
  - running duet state may use `baton: "claude"`.
  - `duet pass --to claude` is accepted for explicit human-directed baton
    handoff.
- Keep `duet loop` on the existing two-agent rotation; `nextDuetAgent()` must
  not auto-schedule Claude yet.
- Add Claude-specific prompt construction.
- Report CLI diagnostics, model, permission policy, estimated tokens, estimated
  max spend, hard budget cap, and tool-execution risk.
- Do not add `--agents`.
- Do not add automatic Claude participation.

Done when:

- `duet pass --to claude` can set a manual Claude baton.
- `duet step --agent claude --dry-run` is local-only and green in tests when
  the baton is Claude.
- Existing `codex|minimax` dry-run/live tests are unchanged.
- `duet loop` still only supports the existing two-agent relay.

### Stage 4: Claude Manual Step Live

Goal: run one explicit Claude step when the human has manually handed the baton
to Claude, then apply Claude's handoff back through the existing duet files.

Files:

- `bridge.mjs`
- `lib/claude-code.mjs`
- `tests/bridge-cli.test.mjs`

Work:

- Enable `duet step --agent claude --yes`.
- Require explicit token-spending approval.
- Before spending, print the same cost preview and hard budget cap that dry-run
  reports.
- Write pending/applied handoff files through the existing hardened `duet pass`
  path; Claude does not mutate duet state directly.
- Require Claude output to choose a valid next recipient from the currently
  supported manual set (`codex` or `minimax` at this stage). Claude-to-Claude
  loops remain out of scope.
- Validate Claude's requested `nextAgent` against that allowlist before
  creating or applying the handoff. Invalid recipients fail the step without
  advancing duet state.
- Record Claude run details in ledger/outbox.
- Preserve the rule that `--yes` is not tool approval.

Done when:

- Fake Claude live step can pass the baton manually back to Codex or MiniMax.
- `duet loop --yes` still does not auto-include Claude.
- Ledger includes Claude usage/cost/result metadata.
- Existing Codex and MiniMax live step behavior does not regress.

### Stage 5: Reports And Token Stats

Goal: make Claude costs visible.

Files:

- `bridge.mjs`
- `tests/bridge-cli.test.mjs`
- docs as needed

Work:

- Update `duet report` to summarize Claude steps.
- Keep `token-stats --ledger` unchanged in this stage. Claude duet usage is
  reported only by `duet report` until a later, explicit token-stats design
  decides whether bridge-ledger and duet-ledger usage should be merged.
- Show cost/cache/usage without leaking raw prompt or handoff text.

Done when:

- `duet report` shows Claude provider/model/cost/tokens.
- `duet report` includes a visible note that Claude usage is not yet merged into
  `token-stats --ledger`.
- `token-stats --ledger` behavior is unchanged and documented as out of scope
  for this stage.
- Redaction behavior remains intact.
- Tests cover mixed Codex/Claude/MiniMax report data where applicable.

### Stage 6: Participant Registry Refactor

Goal: remove the binary `codex|minimax` assumption.

Files:

- `bridge.mjs`
- possibly new `lib/duet-agents.mjs`
- `tests/bridge-cli.test.mjs`
- docs

Work:

- Add persisted `state.agents`.
- Replace `nextDuetAgent(agent)` with `nextDuetAgent(state, agent)`.
- Separate `--agents` from `--require-agents`.
- Add per-agent counts and limits.
- Keep backward compatibility for old state files with no `agents` field.

Done when:

- Existing two-agent relays still work.
- `codex,claude` and `codex,minimax` route correctly in dry-run.
- No hidden fallback sends `codex -> minimax` inside a `codex,claude` relay.

### Stage 7: Multi-Agent Claude Relay

Goal: enable real `codex,claude` and optional `codex,minimax,claude` loops.

Files:

- `bridge.mjs`
- tests
- docs and skills

Work:

- Enable `duet start --agents codex,claude`.
- Enable `duet loop` over arbitrary registered agents.
- Add per-agent loop limits and report counts.
- Update user-facing commands and skills.

Done when:

- `duet start --agents codex,claude` prints correct dry-run/live/report
  commands.
- Fake loop over `codex,claude` passes.
- Fake loop over three agents passes or is explicitly deferred.

### Stage 8: Bidirectional Claude Mode

Goal: support Claude tool permissions and user questions safely.

Files:

- `lib/claude-code.mjs`
- `bridge.mjs`
- tests
- docs

Work:

- Keep stdin open for the step/session.
- Maintain pending control requests.
- Send `control_response`.
- Support `AskUserQuestion`.
- Add audited tool approval policy.
- Support interrupt/cleanup.

Done when:

- Stateful fake CLI can request approval, receive allow/deny, and complete.
- Tool requests are logged and visible.
- No command/file-edit approval is implied by `--yes`.

## Historical Reference Phase Notes

The execution roadmap above is the source of truth for delivery order. The
notes below preserve implementation detail from the earlier plan. They are
historical reference material only: if they conflict with the staged roadmap,
the roadmap wins.

### Phase 1: Adapter Skeleton

Add `lib/claude-code.mjs`.

Responsibilities:

- Resolve Claude CLI path.
- Run a dry installation check.
- Build safe Claude CLI arguments.
- Spawn Claude Code with timeout.
- Parse stream-json stdout.
- Capture stderr summary safely.
- Return a normalized result:

```js
{
  provider: "anthropic",
  agent: "claude",
  model,
  sessionId,
  answer,
  usage: {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens
  },
  costUsd,
  exitCode,
  timedOut,
  diagnostics
}
```

Windows note: on this machine `claude` is visible as a PowerShell function
wrapper, not necessarily as a plain executable. The resolver should prefer:

1. `config.claudeCli`
2. `%USERPROFILE%\.local\bin\claude.exe`
3. `where.exe claude`
4. PowerShell `Get-Command claude` diagnostics
5. a clear doctor error

The resolver must distinguish executable files, `.cmd/.bat` shims, PowerShell
functions/aliases, npm shims, and missing commands. If only a PowerShell
function is found, either give a precise remediation or run through a fixed
PowerShell wrapper without string-built shell fragments.

### Phase 2: Config And Doctor

Add config fields:

- `claudeCli`
- `claudeModel`
- `claudeStepTimeoutSec`
- `claudeMaxBudgetUsd`
- `claudeMaxTurns`
- `claudePermissionMode`

Extend local-only diagnostics:

```powershell
node .\bridge.mjs doctor
node .\bridge.mjs status
```

They should report whether Claude Code is available without spending model
tokens.

Diagnostics should include:

- resolved command path or wrapper type
- source: config, `.local\bin`, PATH, PowerShell function, or missing
- version output when available
- working directory that would be used
- permission/tool policy
- whether a live Claude step can execute local tools
- one-line remediation for each failure

### Phase 3: Single Claude Step Integration

Add:

```powershell
node .\bridge.mjs duet step --agent claude --dry-run
node .\bridge.mjs duet step --agent claude --yes
```

This phase may support manual baton passing with Claude, but it should not yet
promise `duet loop --agents codex,claude` unless the participant registry is
complete.

Dry-run should show:

- CLI found or missing
- selected model
- permission mode
- max turns
- max budget USD
- estimated input tokens
- whether the live step would spend Claude tokens
- whether local tool execution is possible
- whether `control_request` would fail fast or be handled

Safe default: `--yes` confirms the Claude step and token spend only. It must not
mean "auto-approve Bash/Edit/Write". Tool approval policy must be explicit and
audited.

### Phase 4: Duet Agent Registry

Replace the hardcoded two-agent assumption with a small registry:

```text
codex
minimax
claude
```

The existing `codex,minimax` behavior must remain compatible.

This requires more than extending an allowlist. The refactor must define:

- persisted `state.agents`
- routing order / `nextDuetAgent(state, agent)`
- `--agents` semantics distinct from `--require-agents`
- whether `--agents` auto-populates `--require-agents`
- per-agent counts and limits
- backward compatibility for existing state files without `agents`
- report format for arbitrary agents

Until this phase lands, do not advertise `duet start --agents codex,claude` as
available.

### Phase 5: Ledger And Report

Write Claude runs into the existing bridge ledger/outbox conventions.

Record:

- `agent: "claude"`
- `provider: "anthropic"`
- `model`
- `sessionId`
- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheCreationTokens`
- `costUsd`
- `exitCode`
- `timedOut`
- `resultSubtype`
- `isError`
- `stopReason`
- `durationMs`
- `numTurns`
- `permissionDenials`
- `modelUsage`
- `rateLimit`

Update `duet report` so Claude usage appears beside Codex and MiniMax usage.
For the staged MVP, keep Claude cost/cache data in `duet report` only. A later
explicit stats-design pass can decide whether `token-stats --ledger` should
merge bridge-ledger and duet-ledger usage.
Until that later pass exists, `duet report` should clearly say that Claude usage
is not included in `token-stats --ledger`.

### Phase 6: Tests

Do not call real Claude Code in CI.

Add a stateful fake Claude CLI fixture/script that validates argv, reads stdin
NDJSON, and emits JSONL.

Cover:

- missing CLI
- successful result event
- streamed text events
- usage/cost parsing
- `resultSubtype`, `isError`, stop reason, budget/max-turn errors
- non-zero exit
- timeout
- malformed JSON
- stderr capture
- `rate_limit_event`
- `control_request` fail-fast or control-response path
- `AskUserQuestion` behavior
- Windows path with spaces
- `.cmd` shim
- missing executable
- PowerShell function detection
- `duet step --agent claude --dry-run`
- `duet step --agent claude --yes` with fake CLI
- `duet loop` over `codex,claude` only after the registry refactor

### Phase 7: Docs And UX

Update:

- `README.md`
- `docs/USAGE.md`
- `docs/DUET_RELAY.md`
- `docs/COMMANDS.md`
- `prompts/bridge.md`
- `skills/codex-bridge/SKILL.md`
- `skills/bridge/SKILL.md`

Add a concise user phrase:

```text
Use the mavis-minimax-bridge skill and start a codex-claude duet.
```

Before the participant registry lands, phrase this more narrowly:

```text
Use the mavis-minimax-bridge skill and run a Claude review step for this duet.
```

## Estimated Effort

- Adapter skeleton and diagnostics: 0.5-1 day.
- Safe single Claude step with tests/docs: 1-2 days.
- Fully generalized N-agent Duet Relay: 2-4 days.

## Main Risks

- Claude CLI may be a shell function or wrapper on Windows, not a direct
  executable.
- Permission prompts can hang if we enable tools without a control-response
  path. MVP-A should fail fast on `control_request`; MVP-B should implement the
  bidirectional control loop.
- Persistent stream-json sessions are powerful but more stateful; use per-step
  bounded invocation first unless real multi-turn Claude state is required.
- Claude CLI output shape can change. Parser must fail open with diagnostics
  and tests should use representative JSONL fixtures.

## Recommended First Commit

```text
Add Claude Code adapter skeleton
```

Scope:

- `lib/claude-code.mjs`
- fake Claude CLI tests
- config fields
- `doctor` check
- no Duet loop behavior change yet

## Review Notes Incorporated

Two review passes found that the original plan mixed adapter work with a larger
N-agent relay refactor. The plan now treats those as separate phases.

Key corrections:

- `--agents` is deferred until `duet-state.json`, baton routing, loop counters,
  limits, reports, and tests support arbitrary participants.
- `--yes` for Claude is not tool approval.
- `control_request` handling is an explicit MVP choice, not an accidental
  timeout risk.
- Windows PowerShell function wrappers need diagnostics beyond `where.exe`.
- Claude result metadata must include subtype/error/stop/budget/rate-limit
  fields, not just tokens and cost.
