---
name: bridge
description: >-
  Control the local Mavis MiniMax Bridge from MiniMax Code. Use when the user
  types /bridge or asks to connect Codex and MiniMax, inspect bridge state,
  audit token optimization, set a Mavis session, change bridge modes, or run a
  safe collaboration review, including Duet Relay baton-passing. Commands: /bridge status, /bridge audit,
  /bridge doctor, /bridge session, /bridge mode, /bridge estimate, /bridge ask,
  /bridge send, /bridge duet, /bridge help.
---

# Bridge Control

Local control surface for `mavis-minimax-bridge`. The bridge is a filesystem
and HTTP helper, not a daemon. It lives at:

`__BRIDGE_REPO_ROOT__`

Always run commands from that directory.

## Safety

- `doctor`, `status`, `state`, `audit`, `token-stats`, `session show`, `mode list`, and
  `canary-estimate` are local-only and do not intentionally start a model turn.
- `duet init`, `duet show`, `duet next`, `duet packet export`,
  `duet step --dry-run`, `duet pass`, and `duet note` are local-only
  coordination commands. They do not call MiniMax.
- `ask`, `canary`, `optimize-check` without `--skip-canary`, and `mvs-send`
  can spend tokens. Ask for explicit user approval before running them.
- Never send to a burned or denied `mvs_...` session.
- Prefer `ask --mode review-only` before any patch proposal.
- `ask` automatically attaches bounded local Git source context for dirty
  worktrees. Use `--source-context off` only when local source must not be sent,
  repeatable `--include <path>` to attach explicit source from a clean worktree,
  and `--dry-run --raw` to inspect the assembled prompt without spending tokens.
- Keep prompts compact. For multi-turn bridge review, use a small task file
  plus 2-3 focused follow-up task files.
- Duet commands redact relay text by default; use `--raw` only when the user
  intentionally needs local goal, handoff, or journal text in stdout.

## Commands

Parse `/bridge <subcommand>` and run the matching recipe.

### `/bridge help`

Print a short command list:

```powershell
node .\bridge.mjs doctor
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs audit
node .\bridge.mjs token-stats --ledger
node .\bridge.mjs mode list
node .\bridge.mjs session show
node .\bridge.mjs canary-estimate
node .\bridge.mjs duet show
node .\bridge.mjs duet next
node .\bridge.mjs duet packet export --agent minimax
node .\bridge.mjs duet step --agent minimax --dry-run
node .\bridge.mjs duet transcript export
node .\bridge.mjs duet verify --verifier path\to\verify.mjs
```

### `/bridge doctor`

Run:

```powershell
node .\bridge.mjs doctor
```

Report the expected bridge root, current working directory, sentinel files, Git
root diagnostics, and the next command to fix a wrong shell context.

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

### `/bridge duet show`

Run:

```powershell
node .\bridge.mjs duet show
```

Summarize the current relay without printing local goal, handoff, or journal
text. Use `--raw` only when the user explicitly asks for the full local relay
content.

### `/bridge duet next`

Run:

```powershell
node .\bridge.mjs duet next
node .\bridge.mjs duet next --agent codex
node .\bridge.mjs duet next --agent minimax
```

Inspect who should act next. This is local-only and redacted by default.

### `/bridge duet packet export`

Run:

```powershell
node .\bridge.mjs duet packet export --agent minimax
node .\bridge.mjs duet packet export --agent minimax --format markdown --out .\duet-packet.local.md
```

Export a derived packet projection for MiniMax. This is local-only and redacted
by default. Packets are not runtime state.

### `/bridge duet step dry-run`

Run:

```powershell
node .\bridge.mjs duet step --agent minimax --dry-run
```

Preview a future MiniMax step without spending tokens. It validates baton,
status, packet size, route/model, and estimated input tokens.

### `/bridge duet transcript export`

Run:

```powershell
node .\bridge.mjs duet transcript export
node .\bridge.mjs duet transcript export --format markdown --out .\duet-transcript.local.md
```

Export a redacted transcript for review. Use `--raw` only when exact local goal,
handoff, and journal text are intentionally needed.

### `/bridge duet verify <verifier-file>`

Run:

```powershell
node .\bridge.mjs duet verify --verifier path\to\verify.mjs
node .\bridge.mjs duet verify --verifier path\to\verify.mjs --record --agent minimax
```

Run a local Node verifier through the bridge with redacted output by default.
The verifier gets a minimal environment with home/profile and `NODE_OPTIONS`
cleared. Use `--record --agent codex|minimax` only when an active relay should
receive a compact metrics-only verification note.

### `/bridge duet init <goal-file>`

Run:

```powershell
node .\bridge.mjs duet init --goal path\to\goal.md --baton codex --max-iterations 12
```

Use a compact goal file. `duet init` creates ignored local runtime files
`duet-state.json` and `duet-journal.md`.

### `/bridge duet pass <from> [to] <handoff-file>`

Run:

```powershell
node .\bridge.mjs duet pass --from codex --to minimax --handoff path\to\handoff.md
```

The handoff must be a regular file inside the bridge root.

If the relay is complete or needs the human, use:

```powershell
node .\bridge.mjs duet pass --from minimax --status done --handoff path\to\handoff.md
node .\bridge.mjs duet pass --from minimax --status human_escalation --handoff path\to\handoff.md
```

### `/bridge duet note <agent> <note-file>`

Run:

```powershell
node .\bridge.mjs duet note --agent codex --note path\to\note.md
```

### Natural language `let's go`

If the user describes a task and ends with `let's go`, treat that as a request
to start or continue Duet Relay.

Expected behavior:

1. Create a compact `duet-goal.local.md` from the user's task.
2. If no relay exists, run `duet init` with MiniMax as the first baton holder.
3. Run `duet show`.
4. Do the next useful piece of work.
5. Write a compact handoff file.
6. Use `duet pass` to transfer the baton, or finish with `done` /
   `human_escalation`.

Do not run token-spending commands as part of `let's go` unless the user
explicitly approves that separate action.

Duet Relay records the baton and shared state. It does not wake, message, or
activate the other agent automatically. To continue on Codex's side, the user
must open Codex or explicitly approve a separate bridge send step.

### `/bridge ask`

Requires explicit user approval because it starts a model turn. Use a task file.
If the user provides a task file, use:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task path\to\task.md
node .\bridge.mjs ask --yes --mode review-only --task path\to\task.md --include path\to\source
```

If the user provides the request as text, create a compact temporary task file
in this repository first, then use the same `ask --yes` form.

For guided review with task files supplied by the user:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
```

Inspect the prompt and attached source context without spending tokens:

```powershell
node .\bridge.mjs ask --dry-run --raw --task path\to\task.md
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
