# Claude Code Stage 2 Design

## Goal

Implement a stateless, no-tools Claude Code runner that can execute one bounded
prompt through a configured or discovered Claude CLI, normalize stream-json
output, and return diagnostics without changing Duet Relay behavior.

Stage 2 must remain fake-testable and must not call real Claude in CI.

## Non-Goals

- No `duet step --agent claude` yet.
- No participant registry changes.
- No autonomous Claude loop.
- No tool approval flow.
- No persistent Claude session lifecycle.
- No `--resume` user-facing behavior.

## Public Surface

Library-only surface in `lib/claude-code.mjs`:

```js
resolveClaudeCli(options)
buildClaudeArgs(options)
parseClaudeStreamJson(text)
runClaudePrompt(options)
```

Bridge CLI behavior changes are limited to config and doctor readiness. A real
Claude step remains Stage 3/4 work.

`runClaudePrompt()` should stay a thin composer over resolver, argv builder,
spawn/timeout transport, parser, and result shaping. Tests should cover
`buildClaudeArgs()` and `parseClaudeStreamJson()` directly instead of relying
only on spawned fake processes.

## Config

Add conservative config fields:

- `claudeCli`: already added in Stage 1.
- `claudeCliSearchTimeoutMs`: default `5000`.
- `claudeRunnerTimeoutMs`: default `60000`.
- `claudeRequireAvailable`: default `false`.
- `claudeModel`: default `null`.
- `claudeMaxTurns`: default `1`.
- `claudeMaxBudgetUsd`: default `null`.
- `claudePermissionMode`: default `"deny"`.

Validation rules:

- Timeouts must be positive integers.
- `claudeMaxTurns` must be an integer from 1 to 10.
- `claudeMaxBudgetUsd` may be null or a positive number.
- `claudePermissionMode` is one of `"deny"`, `"plan"`, `"default"`.
- Empty strings normalize to null for nullable string fields.

Doctor behavior:

- If `claudeRequireAvailable === false`, missing Claude remains `warn`.
- If `claudeRequireAvailable === true`, missing/non-spawnable Claude becomes
  `fail`.
- Doctor diagnostics expose both `found` and `spawnable` so users can
  distinguish missing binaries from non-spawnable shell wrappers or probe
  errors.

## Runner Contract

`runClaudePrompt(options)` accepts:

```js
{
  prompt,
  cwd,
  cli,              // optional resolved cli diagnostic
  config,           // normalized bridge config subset
  env,              // optional env override for tests
  spawnImpl,        // injectable for tests
  killImpl,         // injectable timeout kill strategy for tests
  now,              // injectable clock
}
```

It returns a normalized result:

```js
{
  ok,
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
  durationMs,
  resultSubtype,
  isError,
  stopReason,
  numTurns,
  permissionDenials,
  rateLimitEvents,
  diagnostics
}
```

All injections are per-call options, not module-level state, so future Stage 3
concurrent calls do not share mutable runner state.

## CLI Arguments

MVP-A no-tools command:

```text
claude --print --input-format stream-json --output-format stream-json --verbose --max-turns 1
```

Optional flags:

- `--model <model>` when `claudeModel` is set.
- `--max-budget-usd <value>` when `claudeMaxBudgetUsd` is set.
- Permission mode flag only after verified against local Claude CLI behavior.

The prompt is sent on stdin as one stream-json user envelope, not raw text:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

The runner must not string-build a shell command. `buildClaudeArgs()` returns an
array of strings, and tests assert that shape.

## Stream Parser

`parseClaudeStreamJson(text)`:

- Parses newline-delimited JSON.
- Tolerates malformed lines by recording diagnostics.
- Collects assistant text deltas and final result text.
- Extracts usage, cost, model, session id, subtype, error state, stop reason,
  turn count, and rate-limit events when present.
- Treats `control_request` and user-question events as failure diagnostics in
  MVP-A, never as prompts to wait for human input. Return shape is `ok: false`,
  `isError: true`, `resultSubtype: "control_request" | "user_question"`, with
  `diagnostics.controlRequest` containing only redacted request id/type/tool
  name, never raw payload content.
- Non-zero process exit without a stronger parser error returns `ok: false`,
  `isError: true`, `resultSubtype: "non_zero_exit"`, `exitCode: <n>`, and
  redacted `diagnostics.stderrSummary`.
- Missing optional numeric fields, including `costUsd`, are represented as
  `null`, not `0`, unless the provider explicitly reports zero.

Fail-open rule: parser errors become diagnostics; the bridge process should not
crash on one malformed Claude line.

## Timeout And Process Cleanup

- Discovery timeout and runner timeout are separate.
- Runner timeout kills the child process tree using `SIGTERM`, waits 2 seconds,
  then escalates to `SIGKILL` when the process is still alive. The kill strategy
  is injectable for tests.
- Timeout result is `ok: false`, `timedOut: true`, with captured stdout/stderr
  summaries.
- Tests use the fake CLI timeout mode; no real Claude process is required.

## Secret Redaction

Diagnostics must redact:

- `Authorization` headers.
- `Proxy-Authorization` headers.
- API key-like values.
- Bearer tokens.
- Environment values containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or
  `AUTH`.

Only redacted stderr/stdout summaries are exposed by public bridge commands.
Before secret matching, summaries strip ANSI escapes and collapse whitespace.
Environment redaction is key-based: redact values for keys containing `KEY`,
`TOKEN`, `SECRET`, `PASSWORD`, or `AUTH`; do not scan all environment values
and redact unrelated text by coincidence.

## Test Plan

Use `tests/helpers/fake-claude.mjs` and fixtures only.

Required tests:

- Build argv defaults.
- Build argv with model, max turns, and budget.
- Parse happy stream-json.
- Parse error result.
- Parse malformed line without throwing.
- Fail fast on `control_request`.
- Timeout kills the fake process.
- Non-zero exit returns clear failure.
- Stderr is summarized and redacted.
- Missing CLI returns failure without spawn.
- Config validation for new Claude fields.
- `doctor` fails only when `claudeRequireAvailable` is true.

## Definition Of Done

- `npm run test:release` is green.
- No real Claude calls in tests.
- No Duet Relay behavior change.
- No ledger writes.
- No tool approvals implied by `--yes`.
- Stage 3 can add dry-run manual Claude duet step using this runner without
  changing the runner contract.
