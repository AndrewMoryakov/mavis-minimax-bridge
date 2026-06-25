---
name: bridge
description: >-
  Control the local Mavis MiniMax Bridge from MiniMax Code. Use when the user
  types /bridge or asks to connect Codex and MiniMax, inspect bridge state,
  audit token optimization, set a Mavis session, change bridge modes, or run a
  safe collaboration review. Commands: /bridge status, /bridge audit,
  /bridge session, /bridge mode, /bridge ask, /bridge help.
---

# Bridge Control

Local control surface for `mavis-minimax-bridge`. The bridge is a filesystem
and HTTP helper, not a daemon. It lives at:

`C:\Users\hopt\.mavis\agents\mavis\workspace\mavis-minimax-bridge`

Always run commands from that directory.

## Safety

- `status`, `state`, `audit`, `token-stats`, `session show`, `mode list`, and
  `canary-estimate` are local-only and do not intentionally start a model turn.
- `ask`, `canary`, `optimize-check` without `--skip-canary`, and `mvs-send`
  can spend tokens. Ask for explicit user approval before running them.
- Never send to a burned or denied `mvs_...` session.
- Prefer `ask --mode review-only` before any patch proposal.
- Keep prompts compact. For multi-turn bridge review, use a small task file
  plus 2-3 focused follow-up task files.

## Commands

Parse `/bridge <subcommand>` and run the matching recipe.

### `/bridge help`

Print a short command list:

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs audit
node .\bridge.mjs token-stats --ledger
node .\bridge.mjs mode list
node .\bridge.mjs session show
node .\bridge.mjs canary-estimate
```

### `/bridge status`

Run:

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
```

Summarize live OpenCode route, current bridge session, denied sessions, modes,
and last ledger events.

### `/bridge audit [mvs_<id>]`

If a session id is provided:

```powershell
node .\bridge.mjs audit --session mvs_<id>
```

Otherwise:

```powershell
node .\bridge.mjs audit
```

Report provider/model routing, largest recent request sections, cache status,
truncation flags, and local ledger token statistics.

### `/bridge session show`

Run:

```powershell
node .\bridge.mjs session show
node .\bridge.mjs deny-session list
```

### `/bridge session set mvs_<id>`

Confirm the id is a real `mvs_...` session supplied by the user, then run:

```powershell
node .\bridge.mjs session set --session mvs_<id>
```

### `/bridge mode max|medium|free`

Run:

```powershell
node .\bridge.mjs mode set --profile <profile>
node .\bridge.mjs mode list
```

### `/bridge mode enforce|observe|off`

Run:

```powershell
node .\bridge.mjs mode set --prompt-cache <mode> --context-budget <mode>
node .\bridge.mjs mode list
```

### `/bridge estimate`

Run:

```powershell
node .\bridge.mjs canary-estimate
```

Use this before any canary that may spend tokens.

### `/bridge ask`

Requires explicit user approval because it starts a model turn. Use a task file.
Preferred form:

```powershell
node .\bridge.mjs ask --mode review-only --task path\to\task.md
```

For guided review:

```powershell
node .\bridge.mjs ask --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
```

### `/bridge send mvs_<id>`

Requires explicit user approval and a compact task file:

```powershell
node .\bridge.mjs mvs-send --session mvs_<id> --task path\to\task.md --yes
```

Use only when the user intentionally wants to post into that exact MiniMax
session.

## Output

Keep the final answer short:

- command run;
- whether it spent tokens;
- main provider/model route;
- risks or warnings;
- one concrete next step.
