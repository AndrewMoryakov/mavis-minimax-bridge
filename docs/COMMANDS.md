# Commands

All commands are local. Commands marked "spends tokens" can trigger a model
turn and should be run only after user approval.

## Status And State

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs config show
npm run check
npm run test:offline
npm run test:release
npm run install:skill
npm run install:codex-skill
npm run install:codex-slash
```

- `status`: inspect live Desktop-owned `opencode serve` config.
- `state`: inspect live server, runtime files, current modes, and recent ledger
  events.
- `config show`: show effective bridge config plus redacted raw local config.
- `test:offline`: run deterministic local tests without MiniMax model turns.
- `test:release`: run syntax check, offline tests, and `git diff --check`.
- `install:skill`: install the optional MiniMax slash-palette skill as
  `/bridge`.
- `install:codex-skill`: install the optional Codex skill as
  `mavis-minimax-bridge`.
- `install:codex-slash`: install the optional Codex CLI custom prompt as
  `/prompts:bridge`.

## MiniMax Slash Skill

Install:

```powershell
npm run install:skill
```

Advanced:

```powershell
node .\scripts\install-mavis-skill.mjs --dry-run
node .\scripts\install-mavis-skill.mjs --mavis-root C:\path\to\.mavis\agents\mavis
node .\scripts\install-mavis-skill.mjs --repo-root C:\path\to\mavis-minimax-bridge
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
/bridge ask <task-file>
/bridge send mvs_<id> <task-file>
```

The slash skill does not add a new daemon. It instructs MiniMax to run the local
bridge CLI from this repository. `status`, `audit`, `session show`, `mode list`,
and `estimate` are local-only. `ask`, `send`, `canary`, and `optimize-check`
without `--skip-canary` can spend tokens and need explicit user approval.
For `/bridge ask` or `/bridge send`, provide a compact task file or ask MiniMax
to create one in the bridge repository before it runs the CLI command.

## Codex Skill

Install:

```powershell
npm run install:codex-skill
npm run install:codex-slash
```

Advanced:

```powershell
node .\scripts\install-codex-skill.mjs --dry-run
node .\scripts\install-codex-skill.mjs --codex-home C:\path\to\.codex
node .\scripts\install-codex-skill.mjs --repo-root C:\path\to\mavis-minimax-bridge
node .\scripts\install-codex-slash.mjs --dry-run
node .\scripts\install-codex-slash.mjs --codex-home C:\path\to\.codex
```

If `CODEX_HOME` is set, the installer writes there automatically and the
`--codex-home` flag can override it.

Default target:

```text
%USERPROFILE%\.codex\skills\mavis-minimax-bridge\SKILL.md
```

After install, Codex can use the skill when the user asks to check bridge
status, audit token optimization, coordinate with MiniMax, set a session, or run
a safe review-only bridge task. The Codex skill uses the same CLI commands and
the same token-spending guardrails as the MiniMax slash skill.

After `install:codex-slash`, restart Codex CLI and use:

```text
/prompts:bridge status
/prompts:bridge audit
/prompts:bridge mode list
/prompts:bridge session show
/prompts:bridge tokens
```

Current Codex CLI custom prompts live under the `prompts:` namespace, so this
does not create a root `/bridge` command.

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

Local-only estimates and route checks:

```powershell
node .\bridge.mjs canary-estimate
node .\bridge.mjs canary-estimate --long-prompt .\stable-prefix.local.txt --repeat-long 2
node .\bridge.mjs optimize-check --skip-canary --session mvs_<id>
```

These commands can spend tokens:

```powershell
node .\bridge.mjs canary --yes
node .\bridge.mjs optimize-check --yes
node .\bridge.mjs optimize-check --yes --long-prompt .\stable-prefix.local.txt --repeat-long 2
```

Run `canary-estimate` before any canary that might spend tokens.
`optimize-check --skip-canary` does not start a model turn. With `--session`,
it still shells out to `mavis usage session`, so the Mavis CLI must be
available.

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
node .\bridge.mjs ask --yes --mode review-only --task .\task.md
node .\bridge.mjs ask --yes --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
node .\bridge.mjs ask --yes --mode patch-proposal --task .\task.md
node .\bridge.mjs mvs-send --session mvs_<id> --task .\task.md --yes
node .\bridge.mjs mvs-send --session mvs_<id> --content "short prompt" --allow-inline-content --yes
```

Prefer `review-only` first. `mvs-send` requires `--yes` because it posts into a
target Mavis session. Repeated `--task` values on `ask` are sent as follow-up
turns in one temporary `ses_...` session and each turn is recorded in the local
ledger/outbox.
Prefer `mvs-send --task` over `--content`; inline content can be captured by
shell history or process inspection.

## Duet Relay

These commands are local-only and do not call MiniMax:

```powershell
node .\bridge.mjs duet init --goal .\duet-goal.local.md --baton codex --max-iterations 12
node .\bridge.mjs duet show
node .\bridge.mjs duet note --agent codex --note .\note.local.md
node .\bridge.mjs duet pass --from codex --to minimax --handoff .\handoff.local.md
node .\bridge.mjs duet pass --from minimax --status done --handoff .\handoff.local.md
node .\bridge.mjs duet pass --from minimax --status human_escalation --handoff .\handoff.local.md
```

`duet init` creates `duet-state.json` and `duet-journal.md` in the repository
root. They are local runtime files and can contain goals, handoffs, local paths,
and coordination history.

Mutating duet commands use a short-lived `duet.lock` file to avoid overlapping
updates from two CLI processes. A lock older than ten minutes is treated as
stale.

Use `duet pass` to transfer the baton or stop the relay with `done` /
`human_escalation`. `--max-iterations` is a safety limit; when reached, the
relay stops with `human_escalation`.

Duet command output is redacted by default: goal, handoff, escalation text, and
journal content are summarized by size and SHA-256. Add `--raw` only when you
intentionally need local relay text in stdout.

For the simplest user flow, describe the task to Codex or MiniMax and end with
`let's go`. See [LETS_GO.md](LETS_GO.md).

Duet Relay records baton state locally. It does not wake, message, or activate
the other agent automatically.

## Logs

```powershell
node .\bridge.mjs tail
node .\bridge.mjs tail --lines 50
node .\bridge.mjs tail --raw
```

`ledger.jsonl`, `inbox.jsonl`, `outbox.jsonl`, `duet-state.json`,
`duet-journal.md`, `duet.lock`, and duet atomic temp files are local runtime
files and are ignored by git.
`tail` redacts sensitive payloads by default; `--raw` prints exact local JSONL.
