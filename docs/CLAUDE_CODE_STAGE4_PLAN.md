# Claude Code Stage 4 Plan

## Goal

Enable one explicit live Claude step after the user manually hands the baton to
Claude:

```powershell
node .\bridge.mjs duet step --agent claude --yes
```

This stage does not add Claude to `duet loop`.

## Contract

Claude must return a handoff with:

```text
Status: running
Next-Agent: codex
```

or:

```text
Status: running
Next-Agent: minimax
```

`Status: done` and `Status: human_escalation` do not need `Next-Agent`.

If `Status: running` lacks a valid `Next-Agent`, the step fails and duet state
is restored to its pre-step value.

Any Claude runner error also fails the step and restores duet state, even when
the assistant text contains a valid `Next-Agent`. A live canary showed that
Claude CLI can emit a usable-looking handoff together with
`error_max_budget_usd`; the bridge must not apply that handoff.

## Scope

Allowed:

- Run `runClaudePrompt()` from `duet step --agent claude --yes`.
- Write pending/applied handoff through existing duet pass flow.
- Record Claude run metadata in ledger/outbox.
- Test with fake Claude CLI only.

Not allowed:

- No Claude auto-loop scheduling.
- No tool approvals.
- No `--agents` registry.
- No Claude-to-Claude handoff.

## Live Canary Notes

- On Windows, prefer a verified `claude.exe` over a stale `.cmd` shim.
- Treat `--max-budget-usd` as a post-run guard for accounting, not as a
  guaranteed pre-request hard cap.
- `doctor` must run a small `--version` probe before reporting Claude as
  spawnable.

## Definition Of Done

- Fake Claude live step can pass to Codex.
- Fake Claude live step can pass to MiniMax.
- Invalid or missing `Next-Agent` fails without advancing duet state.
- Claude runner errors fail without advancing duet state.
- `duet loop --yes` still rejects `baton=claude`.
- `npm run test:release` is green.
