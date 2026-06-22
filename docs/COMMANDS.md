# Commands

All commands are local. Commands marked "spends tokens" can trigger a model
turn and should be run only after user approval.

## Status And State

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs config show
```

- `status`: inspect live Desktop-owned `opencode serve` config.
- `state`: inspect live server, runtime files, current modes, and recent ledger
  events.
- `config show`: show effective bridge config plus raw local config.

## Modes

```powershell
node .\bridge.mjs mode list
node .\bridge.mjs mode set --profile max
node .\bridge.mjs mode set --profile medium
node .\bridge.mjs mode set --profile free
node .\bridge.mjs mode set --prompt-cache enforce
node .\bridge.mjs mode set --prompt-cache observe
node .\bridge.mjs mode set --prompt-cache off
node .\bridge.mjs mode set --context-budget enforce
node .\bridge.mjs mode set --context-budget observe
node .\bridge.mjs mode set --context-budget off
```

Profiles:

- `max`: strongest economy.
- `medium`: balanced.
- `free`: more permissive.

Enforcement modes:

- `enforce`: apply behavior.
- `observe`: report only.
- `off`: disable behavior.

## Session State

```powershell
node .\bridge.mjs session show
node .\bridge.mjs session set --session mvs_<id>
node .\bridge.mjs session clear
```

Use `session set` only with a real `mvs_...` id supplied by the user.

## Deny List

```powershell
node .\bridge.mjs deny-session list
node .\bridge.mjs deny-session add --session mvs_<id>
node .\bridge.mjs deny-session remove --session mvs_<id>
```

Use the deny-list for burned, orchestration, or expensive sessions.

## Token Statistics

```powershell
node .\bridge.mjs token-stats --ledger
node .\bridge.mjs token-stats --session mvs_<id>
node .\bridge.mjs token-stats --session mvs_<id> --ledger
```

- `--ledger`: summarize local bridge canary / optimize-check history.
- `--session`: query `mavis usage session mvs_<id> --json`.

## Canary And Optimization Checks

These commands can spend tokens:

```powershell
node .\bridge.mjs canary-estimate
node .\bridge.mjs canary-estimate --long-prompt .\stable-prefix.local.txt --repeat-long 2
node .\bridge.mjs canary
node .\bridge.mjs optimize-check
node .\bridge.mjs optimize-check --skip-canary --session mvs_<id>
node .\bridge.mjs optimize-check --long-prompt .\stable-prefix.local.txt --repeat-long 2
```

Run `canary-estimate` before any canary that might spend tokens.

## Collaboration

These commands can spend tokens:

```powershell
node .\bridge.mjs ask --mode review-only --task .\task.md
node .\bridge.mjs ask --mode patch-proposal --task .\task.md
node .\bridge.mjs mvs-send --session mvs_<id> --task .\task.md --yes
node .\bridge.mjs mvs-send --session mvs_<id> --content "short prompt" --yes
```

Prefer `review-only` first. `mvs-send` requires `--yes` because it posts into a
target Mavis session.

## Logs

```powershell
node .\bridge.mjs tail
node .\bridge.mjs tail --lines 50
```

`ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local runtime files and
are ignored by git.
