---
name: mavis-minimax-bridge
description: >-
  Operate the local Mavis MiniMax Bridge from Codex. Use when the user asks
  Codex to inspect bridge status, audit MiniMax token optimization, coordinate
  with MiniMax Code, set a Mavis session, change economy modes, run a safe
  canary estimate, use Duet Relay, or send a review-only task through the bridge.
---

# Mavis MiniMax Bridge

Use this skill to control `mavis-minimax-bridge` from Codex.

Repository:

```powershell
__BRIDGE_REPO_ROOT__
```

Always run commands from the repository root.

## Safety

- Local-only commands: `status`, `state`, `config show`, `mode list`,
  `session show`, `deny-session list`, `token-stats --ledger`, `audit`,
  `canary-estimate`, `tail`, and `duet init/show/pass/note`.
- Token-spending commands: `ask`, `mvs-send`, `canary`, and `optimize-check`
  without `--skip-canary`.
- Ask for explicit user approval before running token-spending commands.
- Never send to a burned, denied, or guessed `mvs_...` session.
- Prefer `ask --mode review-only` before any patch proposal.
- Keep task files compact and focused.
- Duet commands redact relay text by default; use `--raw` only when the user
  intentionally needs local goal, handoff, or journal text in stdout.

## Routine Checks

Inspect live bridge and MiniMax routing:

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs mode list
```

Audit token optimization without starting a model turn:

```powershell
node .\bridge.mjs audit
node .\bridge.mjs token-stats --ledger
```

If the user provides a session id:

```powershell
node .\bridge.mjs audit --session mvs_<id>
node .\bridge.mjs token-stats --session mvs_<id>
```

## State Changes

Set the current MiniMax session only when the user provides the id:

```powershell
node .\bridge.mjs session set --session mvs_<id>
```

Put known-bad sessions on the deny-list:

```powershell
node .\bridge.mjs deny-session add --session mvs_<id>
```

Change economy profile:

```powershell
node .\bridge.mjs mode set --profile max
node .\bridge.mjs mode set --profile medium
node .\bridge.mjs mode set --profile free
```

Change enforcement modes:

```powershell
node .\bridge.mjs mode set --prompt-cache enforce --context-budget enforce
node .\bridge.mjs mode set --prompt-cache observe --context-budget observe
node .\bridge.mjs mode set --prompt-cache off --context-budget off
```

## Duet Relay

Use Duet Relay when Codex and MiniMax need to pass a task back and forth after
the human gives the initial goal. These commands are local-only and do not send
a model prompt:

```powershell
node .\bridge.mjs duet init --goal path\to\goal.md --baton codex --max-iterations 12
node .\bridge.mjs duet show
node .\bridge.mjs duet pass --from codex --to minimax --handoff path\to\handoff.md
node .\bridge.mjs duet note --agent codex --note path\to\note.md
```

Finish or escalate:

```powershell
node .\bridge.mjs duet pass --from minimax --status done --handoff path\to\handoff.md
node .\bridge.mjs duet pass --from minimax --status human_escalation --handoff path\to\handoff.md
```

`duet-state.json`, `duet-journal.md`, `duet.lock`, and duet atomic temp files
are local ignored runtime files. Keep handoffs compact; goal, handoff, and note
files are limited to 20000 characters.

## Collaboration With MiniMax

Estimate before spending tokens:

```powershell
node .\bridge.mjs canary-estimate
```

Use a task file for review-only collaboration:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task path\to\task.md
```

Use repeated `--task` arguments for a compact multi-turn review:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
```

Post to an existing MiniMax session only after explicit approval:

```powershell
node .\bridge.mjs mvs-send --session mvs_<id> --task path\to\task.md --yes
```

## Reporting

In the final answer, include:

- commands run;
- whether any command spent tokens;
- current main provider/model route;
- warnings or failed checks;
- the next concrete action.
