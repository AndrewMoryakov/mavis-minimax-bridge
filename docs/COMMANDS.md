# Commands

All commands are local. Commands marked "spends tokens" can trigger a model
turn and should be run only after user approval.

## Status And State

```powershell
node .\bridge.mjs doctor
node .\bridge.mjs status
node .\bridge.mjs state
node .\bridge.mjs config show
npm run doctor
npm run check
npm run test:offline
npm run test:release
npm run install:skill
npm run install:codex-skill
npm run install:codex-slash
```

- `doctor`: verify that the current working directory is the bridge root before
  running workspace-sensitive commands.
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
node .\bridge.mjs ask --yes --mode review-only --task .\task.md --include .\src
node .\bridge.mjs ask --yes --mode review-only --task .\q1.md --task .\q2.md --task .\q3.md
node .\bridge.mjs ask --yes --mode patch-proposal --task .\task.md
node .\bridge.mjs ask --dry-run --raw --task .\task.md
node .\bridge.mjs mvs-send --session mvs_<id> --task .\task.md --yes
node .\bridge.mjs mvs-send --session mvs_<id> --content "short prompt" --allow-inline-content --yes
```

Prefer `review-only` first. `mvs-send` requires `--yes` because it posts into a
target Mavis session. Repeated `--task` values on `ask` are sent as follow-up
turns in one temporary `ses_...` session and each turn is recorded in the local
ledger/outbox.
`ask` automatically attaches a bounded local source context when the Git
worktree is dirty. The context includes `git status`, diff output, and text
snippets for untracked files so MiniMax can review changes that are not visible
in its own session. Use repeatable `--include <path>` to attach explicit files
or directories from a clean worktree. Included paths must stay inside the bridge
root; runtime files, task files, binary-looking files, and ignored local scratch
files are skipped. Use `--source-context off` to disable source context; it
cannot be combined with `--include`. Use `--dry-run --raw` to inspect the
assembled prompt without starting a model turn.
Prefer `mvs-send --task` over `--content`; inline content can be captured by
shell history or process inspection.

## Duet Relay

These commands coordinate Duet Relay. `duet start`, `duet init`, `duet show`,
`duet next`, packet/report/transcript export, dry-runs, `pass`, `note`, and
`verify` are local-only. `duet step --agent minimax --yes`,
`duet step --agent codex --yes`, and `duet loop --yes` can call agents and
spend tokens:

```powershell
node .\bridge.mjs duet start --goal .\duet-goal.local.md --baton codex --max-iterations 12
node .\bridge.mjs duet init --goal .\duet-goal.local.md --baton codex --max-iterations 12
node .\bridge.mjs duet start --goal .\duet-goal.local.md --agents codex,claude --baton codex
node .\bridge.mjs duet show
node .\bridge.mjs duet next
node .\bridge.mjs duet next --agent minimax
node .\bridge.mjs duet packet export --agent codex
node .\bridge.mjs duet packet export --agent minimax
node .\bridge.mjs duet packet export --agent minimax --format markdown --out .\duet-packet.local.md
node .\bridge.mjs duet step --agent minimax --dry-run
node .\bridge.mjs duet step --agent codex --dry-run
node .\bridge.mjs duet step --agent codex --dry-run --codex-mode isolated
node .\bridge.mjs duet step --agent minimax --yes
node .\bridge.mjs duet step --agent codex --yes
node .\bridge.mjs duet loop --dry-run --require-agents codex,minimax --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 60000
node .\bridge.mjs duet loop --yes --require-agents codex,minimax --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 60000
node .\bridge.mjs duet loop --yes --require-agents codex,claude --max-rounds 12 --max-codex-steps 12 --max-claude-steps 12 --max-tokens 60000
node .\bridge.mjs duet loop --yes --require-agents codex,minimax,claude --max-rounds 12 --max-codex-steps 12 --max-minimax-steps 12 --max-claude-steps 12 --max-tokens 60000
node .\bridge.mjs duet loop --dry-run --profile smoke --require-agents codex,minimax
node .\bridge.mjs duet report
node .\bridge.mjs duet report --format markdown --out .\duet-report.local.md
node .\bridge.mjs duet transcript export
node .\bridge.mjs duet transcript export --format markdown --out .\duet-transcript.local.md
node .\bridge.mjs duet verify --verifier .\examples\duet-tetris-browser\verify.mjs -- --skip-relay-check
node .\bridge.mjs duet verify --verifier .\verify.mjs --record --agent codex -- --fast
node .\bridge.mjs duet note --agent codex --note .\note.local.md
node .\bridge.mjs duet pass --from codex --to minimax --handoff .\handoff.local.md
node .\bridge.mjs duet pass --from minimax --status done --handoff .\handoff.local.md
node .\bridge.mjs duet pass --from minimax --status human_escalation --handoff .\handoff.local.md
```

`duet init` creates `duet-state.json` and `duet-journal.md` in the repository
root. They are local runtime files and can contain goals, handoffs, local paths,
and coordination history.

Use `--agents codex,minimax`, `--agents codex,claude`, or
`--agents codex,minimax,claude` to define the relay participants. Manual
handoffs must stay inside that registry. Claude can participate in manual
handoffs, `duet step --agent claude --yes`, and bounded `duet loop` runs. The
default Claude step cap is 12 for real work; lower `--max-claude-steps`
explicitly for smoke or budget-sensitive runs.

Use `duet start` when a human wants the simplest safe launch packet. It
initializes the relay through the same path as `duet init`, then returns
redacted `show`, `next`, `loop --dry-run`, `loop --yes`, and `report` commands.
It is local-only and does not call Codex, MiniMax, or a verifier.

Run workspace-sensitive bridge commands from the bridge repository root. The
workspace guard blocks `duet`, `ask`, `mvs-send --task`, and `--long-prompt`
canary inputs when the current working directory is not the bridge root. Use
`node .\bridge.mjs doctor` if the active shell may be in another project.

Mutating duet commands use a short-lived `duet.lock` file to avoid overlapping
updates from two CLI processes. A lock older than ten minutes is treated as
stale. The bridge refuses to remove stale locks automatically because that can
race with another writer; verify that no bridge command is running, then remove
the lock manually if recovery is needed.

Use `duet pass` to transfer the baton or stop the relay with `done` /
`human_escalation`. `--max-iterations` is a safety limit; when reached, the
relay stops with `human_escalation`. Handoff files must be regular files inside
the bridge root.

Duet command output is redacted by default: goal, handoff, escalation text, and
journal content are summarized by size and SHA-256. Add `--raw` only when you
intentionally need local relay text in stdout.

Use `duet transcript export` to produce a redacted JSON or Markdown transcript
for review. Add `--raw` only when local goal, handoff, and journal text are
intentionally needed. Raw file exports require a `.local.*` output path.

Use `duet next` to inspect baton ownership before acting. It is local-only and
redacted by default. It reports whether the requested `--agent codex|minimax`
may act, terminal or wrong-baton warnings, static next-action hints, and the
latest recorded verifier summary.

Use `duet packet export --agent codex|minimax` to create a derived packet
projection for either agent side. It is local-only and redacted by default. Packets are
derived from `duet-state.json` and `duet-journal.md`; they are not runtime
state. Raw file output requires explicit `--raw` and a `.local.*` path inside
the bridge root.

Use `duet step --dry-run` to preview a future agent step without spending
tokens. It validates status, baton ownership, iteration limits, packet size,
route/model or Codex CLI settings, selected `codexMode`, and estimated input
tokens.

Use `duet step --agent minimax --yes` to run one real MiniMax review-only relay
turn. This can spend tokens. The bridge writes MiniMax's answer to a pending
`.local.md` handoff, applies it through hardened `duet pass` validation, and
redacts the answer by default. If apply fails, the baton is not advanced and the
pending handoff path is returned for manual recovery.

Use `duet step --agent codex --yes` to run one real non-interactive Codex relay
turn. This can spend OpenAI/Codex tokens. The bridge invokes `codex exec` with
`--ephemeral`, explicit `--cd`, explicit `approval_policy='never'`, and a
bridge timeout. The child Codex process still loads the user's Codex config and
rules; current Codex CLI builds require that for `workspace-write` to take
effect. `--codex-mode exec` runs in the bridge workspace with
`workspace-write`; `--codex-mode isolated` runs in an empty scratch workspace
with `read-only` and `--skip-git-repo-check`. This reduces workspace exposure,
but it is not a hard security boundary. Exec mode can modify bridge repository
files and local runtime files; use isolated mode for safer review-only relay
turns. The last Codex message is written to a pending `.local.md` handoff and
applied through the same hardened `duet pass` path.

Use `duet loop --dry-run` to preview a future autonomous loop without spending
tokens. It does not run Codex, MiniMax, or a verifier. It reports whether the
current relay can continue, which agent would act next, estimated input tokens,
loop limits, optional verifier configuration, required-agent settings, and stop
reasons.

Add `--profile smoke` for compact live validation. It defaults to two rounds,
one Codex step, one MiniMax step, one Claude step, a smaller packet budget, the
standard token budget, and `--codex-mode isolated`. Isolated mode uses a
scratch read-only workspace, not hard security. Explicit `--max-*` and
`--codex-mode` flags still override the profile.

Use `duet loop --yes` to run a bounded autonomous loop. This can spend
Codex/OpenAI, MiniMax, and Anthropic/Claude tokens depending on the registered
agents. It alternates the current baton holder through the same hardened
`duet step --agent <agent> --yes` path, optionally runs a verifier between
running steps, and stops on terminal relay status, max rounds, per-agent step
limits, token budget, repeated handoff hash, apply failure, or verifier
failure.

Claude CLI cost controls are not a hard pre-request cap in every observed
runtime path. Prefer a dry-run before any live loop that includes Claude, and
lower `--max-claude-steps` explicitly for smoke or budget-sensitive runs.

Add `--require-agents codex,minimax`, `--require-agents codex,claude`, or
`--require-agents codex,minimax,claude` to require specific agents before final
`done`. If an early agent returns `done`, the loop records
`suppressedTerminalStatus` and routes a running handoff to the next missing
required agent. It does not suppress `human_escalation`.

Use `duet report` after a loop or step sequence to get a redacted run summary.
It reads the current relay state and the latest `duet-loop` ledger event, then
reports stop reasons, step counts, token usage, budget diagnostics, verifier
summaries, recent `duet-step` provider/model/token/cost totals including Claude
steps, transcript hashes, and suggested continuation commands. It is
local-only and does not print goal, handoff, or journal text. Claude duet usage
is shown here only for now; `token-stats --ledger` is unchanged and does not
merge Claude duet costs in this stage.

Use `duet verify` to run a Node verifier through the bridge. Verifiers must be
`.js`, `.mjs`, or `.cjs` files inside the bridge root. The command uses
`shell: false`, a scratch working directory, a timeout, and redacted
stdout/stderr summaries by default. Verifiers receive a minimal environment
with home/profile and `NODE_OPTIONS` cleared. Add `--raw` only when verifier
output text is intentionally needed; raw streams are still capped. Add
`--record --agent codex|minimax` to append a
compact metrics-only verification note to an active Duet journal.

For the simplest user flow, describe the task to Codex or MiniMax and end with
`let's go`. See [LETS_GO.md](LETS_GO.md).

For a longer autonomous run where the human approves one bounded live loop and
then reads the final report, see [LIVE_RUNBOOK.md](LIVE_RUNBOOK.md).

Duet Relay records baton state locally. `duet start`, `duet init`, manual
passes, and dry-runs are local-only. Live `duet loop --yes` can activate the
registered agents after explicit approval.

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
