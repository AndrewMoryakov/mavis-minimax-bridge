# Mavis MiniMax Bridge

Local JSONL bridge for controlled collaboration between Codex-style agents and
MiniMax Code / Mavis.

The bridge talks to the Desktop-owned `opencode serve` HTTP API and, when a
real `mvs_...` session id is supplied, can also query `mavis usage session` for
token metrics.

## Status

Experimental, Windows-first, and intentionally conservative. It is designed for
short coordination, review-only turns, and token-optimization canaries. It is
not a daemon and it does not ship secrets, ledgers, or MiniMax vendor code.

## Install

Clone the repository, then optionally create a local config:

```powershell
git clone https://github.com/AndrewMoryakov/mavis-minimax-bridge.git
cd mavis-minimax-bridge
npm run init
npm run install:skill
npm run install:codex-skill
node .\bridge.mjs status
```

This creates the local runtime skeleton:

```text
config.json
ledger.jsonl
inbox.jsonl
outbox.jsonl
```

These files are ignored by git. Keep local session ids, paths, deny-lists, and
coordination history there.

## AI Agent Install

Use this checklist when another AI agent needs to deploy the bridge on a user
machine.

Prerequisites:

- Windows with MiniMax Code / Mavis already installed and running.
- Node.js 20+ available as `node`.
- Git available as `git`.
- Mavis CLI available as `mavis`, or installed at `%USERPROFILE%\.mavis\bin\mavis.cmd`.
- User approval before sending any prompt that can start a model turn.

Install:

```powershell
git clone https://github.com/AndrewMoryakov/mavis-minimax-bridge.git
cd mavis-minimax-bridge
npm run init
node --check .\bridge.mjs
node .\bridge.mjs status
npm run install:skill
npm run install:codex-skill
```

Configure:

1. Open `config.json`.
2. Set `currentMavisSession` only if the user gives a real `mvs_...` session id.
3. Add burned, expensive, or orchestration sessions to `denySessions`.
4. Leave `requireModel` as `minimax/MiniMax-M3` unless the user explicitly wants another main model.
5. Keep `maxInputTokens`, `mvsMaxSendChars`, and `maxLongPromptChars` conservative.

Verify without spending model tokens:

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs mode list
node .\bridge.mjs token-stats --ledger
node .\bridge.mjs audit
node .\bridge.mjs canary-estimate
node .\bridge.mjs optimize-check --skip-canary --session mvs_<id>
```

`optimize-check --skip-canary` does not start a model turn. When `--session` is
provided it still queries `mavis usage session`, so the Mavis CLI must be
available.

Optional MiniMax GUI slash entry:

```powershell
npm run install:skill
```

This installs an agent-local `bridge` skill into
`%USERPROFILE%\.mavis\agents\mavis\skills\bridge\SKILL.md`. MiniMax uses the
skills list for its slash palette, so users can type `/bridge status`,
`/bridge audit`, `/bridge session`, `/bridge mode`, or `/bridge ask`. The skill
is only a safe router to the local CLI; token-spending commands still require
explicit user approval.

Advanced MiniMax install options:

```powershell
node .\scripts\install-mavis-skill.mjs --dry-run
node .\scripts\install-mavis-skill.mjs --mavis-root C:\path\to\.mavis\agents\mavis
node .\scripts\install-mavis-skill.mjs --repo-root C:\path\to\mavis-minimax-bridge
```

Optional Codex skill:

```powershell
npm run install:codex-skill
```

This installs a Codex skill into
`%USERPROFILE%\.codex\skills\mavis-minimax-bridge\SKILL.md`. Codex can then
auto-trigger the bridge workflow when the user asks to inspect bridge status,
audit MiniMax token optimization, coordinate with MiniMax, set a session, or run
a review-only bridge task.

Advanced Codex install options:

```powershell
node .\scripts\install-codex-skill.mjs --dry-run
node .\scripts\install-codex-skill.mjs --codex-home C:\path\to\.codex
node .\scripts\install-codex-skill.mjs --repo-root C:\path\to\mavis-minimax-bridge
```

If `CODEX_HOME` is set, the installer writes there automatically and the
`--codex-home` flag can override it.

Run a tiny canary only after user approval:

```powershell
node .\bridge.mjs canary-estimate
node .\bridge.mjs optimize-check --yes
```

Use for collaboration:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task .\task.md
node .\bridge.mjs ask --yes --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
node .\bridge.mjs mvs-send --session mvs_<id> --task .\task.md --yes
```

Repeated `--task` values are sent as follow-up turns in one temporary
`ses_...` session. Use this for guided reviews where MiniMax needs a few compact
questions to discover problems.

Rules for agents:

- Do not commit or publish `config.json`, `ledger.jsonl`, `inbox.jsonl`, or `outbox.jsonl`.
- Do not use `mvs-send`, `canary`, `ask`, or `optimize-check` without understanding that they may spend tokens.
- The CLI requires `--yes` for token-spending bridge commands; `optimize-check --skip-canary` does not start a model turn.
- Prefer `review-only` tasks before asking MiniMax to propose changes.
- Keep bridge tasks compact and bounded.
- Treat direct MiniMax prompt-cache savings as unproven unless an A/B run proves
  cache behavior changed.
- Check `finishReason`, `truncated`, `nearOutputCap`, and `cacheStatus` in
  bridge output before trusting a review answer.
- Record important results in `ledger.jsonl` by using bridge commands, not manual edits.

## Commands

```powershell
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs config show
node .\bridge.mjs mode list
node .\bridge.mjs mode set --profile max --prompt-cache enforce --context-budget enforce
node .\bridge.mjs session show
node .\bridge.mjs session set --session mvs_<id>
node .\bridge.mjs session clear
node .\bridge.mjs deny-session list
node .\bridge.mjs deny-session add --session mvs_<id>
node .\bridge.mjs deny-session remove --session mvs_<id>
node .\bridge.mjs token-stats --ledger
node .\bridge.mjs token-stats --session mvs_<id>
node .\bridge.mjs audit
node .\bridge.mjs audit --session mvs_<id>
node .\bridge.mjs canary-estimate
node .\bridge.mjs canary --yes
node .\bridge.mjs optimize-check --yes
node .\bridge.mjs optimize-check --yes --session mvs_<id>
node .\bridge.mjs optimize-check --yes --long-prompt path\to\stable-prefix.txt
node .\bridge.mjs ask --yes --mode review-only --task path\to\task.md
node .\bridge.mjs ask --yes --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
node .\bridge.mjs mvs-status --session mvs_<id>
node .\bridge.mjs mvs-peers --session mvs_<id>
node .\bridge.mjs mvs-messages --session mvs_<id> --limit 5
node .\bridge.mjs mvs-send --session mvs_<id> --task path\to\task.md --yes
node .\bridge.mjs tail
```

GUI slash skill equivalents after `npm run install:skill`:

```text
/bridge status
/bridge audit
/bridge session show
/bridge session set mvs_<id>
/bridge mode max
/bridge mode enforce
/bridge estimate
/bridge ask <task-file>
```

Codex skill install:

```powershell
npm run install:codex-skill
```

After installing, ask Codex in natural language, for example: "check bridge
status", "audit MiniMax token optimization through the bridge", or "send a
review-only task to MiniMax through the bridge".

`audit` is local-only: it reads the bridge ledger, recent MiniMax plugin logs,
OpenCode routing, and optional `mavis usage session` data. It does not send a
model request. Direct MiniMax prompt-cache savings are reported as unproven
unless an A/B run shows that disabling the prompt-cache patch reduces
`cacheRead`. Bridge turns also record `finishReason`, `truncated`,
`nearOutputCap`, `cacheStatus`, and the compact `optimizationContext` that was
sent with the prompt.

## State And Modes

Use these commands before spending tokens:

```powershell
node .\bridge.mjs state
node .\bridge.mjs mode list
node .\bridge.mjs token-stats --ledger
```

Change local bridge state without hand-editing `config.json`:

```powershell
node .\bridge.mjs mode set --profile max
node .\bridge.mjs mode set --prompt-cache enforce --context-budget enforce
node .\bridge.mjs session set --session mvs_<id>
node .\bridge.mjs deny-session add --session mvs_<id>
```

Available profile modes:

- `max`: strongest economy mode.
- `medium`: balanced mode.
- `free`: more permissive mode.

Available enforcement modes:

- `enforce`: actively apply configured behavior.
- `observe`: observe/report only.
- `off`: disable that behavior.

## Token Optimizer Check

`optimize-check` verifies:

- main route is direct `minimax/MiniMax-M3`;
- non-main lifecycle roles are routed to `openrouter/...`;
- a tiny two-turn canary can complete;
- response metadata reports provider/model/cache counters when available;
- optional `mavis usage session mvs_<id> --json` stays under `maxInputTokens`.

`cacheWriteObserved=false` does not automatically fail the verdict. Provider
cache reporting can remain zero on tiny prompts. Use `--long-prompt <file>`
only when you intentionally want a cache-write canary.

The bridge adds a small `<optimization_context>` block to model prompts by
default. It tells MiniMax the current role, route, output cap, cache status, and
whether the previous answer looked truncated. Disable it only for strict A/B
tests:

```powershell
node .\bridge.mjs config set --key includeOptimizationContext --value false
```

Estimate token exposure before spending tokens:

```powershell
node .\bridge.mjs canary-estimate
node .\bridge.mjs canary-estimate --long-prompt path\to\stable-prefix.txt
node .\bridge.mjs canary-estimate --long-prompt path\to\stable-prefix.txt --repeat-long 2
```

Build a realistic local long-prompt file from repository docs/config:

```powershell
npm run prefix:build
node .\bridge.mjs canary-estimate --long-prompt .\stable-prefix.local.txt --repeat-long 2
```

## Safety

- `ask`, `canary`, `mvs-send`, and full `optimize-check` require `--yes`
  because they start a model turn.
- `tail` redacts log payloads by default; use `tail --raw` only when you
  intentionally need exact local JSONL contents.
- `--long-prompt` is opt-in because it spends more tokens.
- Put burned, orchestration, or expensive sessions in `denySessions`.
- `ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local audit files and
  are ignored by git.
- stdout escapes non-ASCII by default for legacy Windows admin consoles, while
  JSONL files are written as UTF-8.

See [docs/RUNTIME_FILES.md](docs/RUNTIME_FILES.md) for the runtime file
contract.

See [docs/COMMANDS.md](docs/COMMANDS.md) for the full command reference,
including status, modes, token statistics, and state-changing commands.

After a MiniMax Code update or reinstall, see
[docs/RESTORE_AFTER_UPDATE.md](docs/RESTORE_AFTER_UPDATE.md).

## Related

This bridge was split out from the MiniMax token optimization work:

https://github.com/AndrewMoryakov/minimax-code-token-optimizer
