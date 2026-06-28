# Claude Code Stage 3 Plan

## Goal

Add a local-only manual dry-run path for Claude:

```powershell
node .\bridge.mjs duet pass --from codex --to claude --handoff .\handoff.local.md
node .\bridge.mjs duet step --agent claude --dry-run
```

Stage 3 must not call Claude. Live `duet step --agent claude --yes` remains
Stage 4.

## Boundary

Allowed:

- Accept `claude` in manual duet state/pass/packet/dry-run paths.
- Produce a Claude-specific dry-run report using Stage 2 config and resolver.
- Estimate prompt tokens and show cost/tool risk.
- Keep `duet loop` two-agent only.

Not allowed:

- No live Claude spawn.
- No ledger writes for Claude usage.
- No `duet loop` auto-scheduling Claude.
- No `--agents` participant registry.
- No tool approval behavior.
- No permission-mode CLI flag until local Claude behavior is verified.

## Implementation Steps

1. Split agent allowlists:
   - `duetManualAgents = codex|minimax|claude`
   - `duetLoopAgents = codex|minimax`
2. Update manual state/pass/packet validation to allow `claude`.
3. Keep `nextDuetAgent(agent)` explicitly two-agent only:
   - `codex -> minimax`
   - `minimax -> codex`
   - `claude` throws with a clear error; callers must pass `--to`.
4. Add `duetStepPrompt("claude", packet)`:
   - Ask Claude to produce a compact handoff.
   - State no tools are approved.
   - Require explicit next recipient `codex` or `minimax` for future Stage 4.
5. Extend `duetStepDryRun()` for `agent === "claude"`:
   - `mode: "dry-run"`
   - `tokenSpending: false`
   - `wouldCallModel: false` or `wouldCallClaude: true`
   - route includes Claude CLI diagnostic, model, max turns, max budget,
     permission mode, runner timeout, and tool risk.
   - If CLI missing, dry-run still succeeds but warns; if
     `claudeRequireAvailable` is true, dry-run exits non-zero.
6. Keep `duetStepLive()` rejecting `--agent claude --yes` with a Stage 4 error.
7. Update help/docs to show Claude dry-run only.

## Tests

- `duet start --baton claude` is accepted.
- `duet pass --to claude` is accepted.
- `duet step --agent claude --dry-run` is local-only and returns:
  - Claude route/config diagnostics
  - prompt estimate
  - no token spending
  - no live model call
- `duet step --agent claude --yes` fails with Stage 4-not-implemented error.
- `nextDuetAgent("claude")` / loop preview fails clearly instead of silently
  routing to another agent.
- `duet step --agent claude --dry-run` with `claudeRequireAvailable=true` and
  missing CLI exits non-zero.
- `duet loop --dry-run` with `baton: claude` fails clearly and does not preview
  a Claude loop step.
- Existing `codex|minimax` tests remain unchanged.

## Definition Of Done

- `npm run test:release` green.
- MiniMax review approves before commit.
- No real Claude call.
- No ledger usage entry for Claude.
- Stage 4 can reuse the dry-run prompt/route shape.
