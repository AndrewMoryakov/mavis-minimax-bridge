# Commands

All commands are local. Commands marked "spends tokens" can trigger a model
turn and should be run only after user approval.

## Status And State

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs config show
npm run install:skill
```

- `status`: inspect live Desktop-owned `opencode serve` config.
- `state`: inspect live server, runtime files, current modes, and recent ledger
  events.
- `config show`: show effective bridge config plus raw local config.
- `install:skill`: install the optional MiniMax slash-palette skill as
  `/bridge`.

## MiniMax Slash Skill

Install:

```powershell
npm run install:skill
```

After MiniMax refreshes its skill index, use:

```text
/bridge help
/bridge status
/bridge audit
/bridge audit mvs_<id>
/bridge session show
/bridge session set mvs_<id>
/bridge mode max
/bridge mode medium
/bridge mode free
/bridge mode enforce
/bridge mode observe
/bridge mode off
/bridge estimate
/bridge ask
/bridge send mvs_<id>
```

The slash skill does not add a new daemon. It instructs MiniMax to run the local
bridge CLI from this repository. `status`, `audit`, `session show`, `mode list`,
and `estimate` are local-only. `ask`, `send`, `canary`, and `optimize-check`
without `--skip-canary` can spend tokens and need explicit user approval.

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
node .\bridge.mjs audit
node .\bridge.mjs audit --session mvs_<id>
node .\bridge.mjs audit --lines 500 --plugin-lines 800
```

- `--ledger`: summarize local bridge canary / optimize-check history.
- `--session`: query `mavis usage session mvs_<id> --json`.

`audit` is local-only. It joins bridge JSONL events, recent `plugin-*.log`
request summaries, current OpenCode routing, prompt-cache patch logs, and
optional `mavis usage` data. It reports provider/role/model groups and flags
risks such as growing OpenRouter request bodies or direct MiniMax cache savings
that are not proven by A/B data.

Audit groups also include:

- `maxSystemBytes`, `maxMessageBytes`, `maxToolBytes`: largest observed request
  sections for that provider/role/model group.
- `maxBodySessionID`: session id for the largest observed request body when
  available.
- `truncatedTurns`: bridge turns whose provider metadata looked output-limited.
- `nearOutputCapTurns`: bridge turns that used at least the configured output
  cap ratio.
- `unknownFinishReasonTurns`: bridge turns where the provider did not surface a
  usable finish reason.

`pluginLogs.topRequests` lists the largest recent provider requests with section
bytes and session ids. Use it to decide whether the next fix should target
system prompt size, tool definitions, or accumulated message history.

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

Each bridge model turn records `finishReason`, `truncated`, `outputCap`,
`nearOutputCap`, `cacheStatus`, and `optimizationContext` in the local ledger.
The bridge injects a compact `<optimization_context>` prompt block by default so
MiniMax can account for the current route, output cap, cache status, and whether
the previous answer looked truncated.

Disable the prompt block only for strict A/B tests:

```powershell
node .\bridge.mjs config set --key includeOptimizationContext --value false
```

## Collaboration

These commands can spend tokens:

```powershell
node .\bridge.mjs ask --mode review-only --task .\task.md
node .\bridge.mjs ask --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
node .\bridge.mjs ask --mode patch-proposal --task .\task.md
node .\bridge.mjs mvs-send --session mvs_<id> --task .\task.md --yes
node .\bridge.mjs mvs-send --session mvs_<id> --content "short prompt" --yes
```

Prefer `review-only` first. `mvs-send` requires `--yes` because it posts into a
target Mavis session. Repeated `--task` values on `ask` are sent as follow-up
turns in one temporary `ses_...` session and each turn is recorded in the local
ledger/outbox.

## Logs

```powershell
node .\bridge.mjs tail
node .\bridge.mjs tail --lines 50
```

`ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local runtime files and
are ignored by git.
