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

- Local-only commands: `doctor`, `status`, `state`, `config show`, `mode list`,
  `session show`, `deny-session list`, `token-stats --ledger`, `audit`,
  `canary-estimate`, `tail`, `duet start/init/show/next/pass/note`,
  `duet packet export`, `duet step --dry-run`, `duet loop --dry-run`, and
  `duet report`.
- Token-spending commands: `ask`, `mvs-send`, `canary`, `optimize-check`
  without `--skip-canary`, `duet step --agent minimax --yes`, and
  `duet step --agent codex --yes`, and `duet loop --yes`.
- Ask for explicit user approval before running token-spending commands.
- Never send to a burned, denied, or guessed `mvs_...` session.
- Prefer `ask --mode review-only` before any patch proposal.
- `ask` automatically attaches bounded local Git source context for dirty
  worktrees. Use `--source-context off` only when local source must not be sent,
  repeatable `--include <path>` to attach explicit source from a clean worktree,
  and `--dry-run --raw` to inspect the assembled prompt without spending tokens.
- Keep task files compact and focused.
- Duet commands redact relay text by default; use `--raw` only when the user
  intentionally needs local goal, handoff, or journal text in stdout.

## Routine Checks

Inspect live bridge and MiniMax routing:

```powershell
node .\bridge.mjs doctor
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
the human gives the initial goal. These commands are local-only except for
explicit `duet step --agent minimax --yes` and
`duet step --agent codex --yes` / `duet loop --yes`:

```powershell
node .\bridge.mjs duet start --goal path\to\goal.md --baton codex --max-iterations 12
node .\bridge.mjs duet init --goal path\to\goal.md --baton codex --max-iterations 12
node .\bridge.mjs duet show
node .\bridge.mjs duet next
node .\bridge.mjs duet packet export --agent minimax
node .\bridge.mjs duet step --agent minimax --dry-run
node .\bridge.mjs duet step --agent codex --dry-run
node .\bridge.mjs duet step --agent minimax --yes
node .\bridge.mjs duet step --agent codex --yes
node .\bridge.mjs duet loop --dry-run
node .\bridge.mjs duet loop --yes
node .\bridge.mjs duet report
node .\bridge.mjs duet transcript export
node .\bridge.mjs duet verify --verifier path\to\verify.mjs
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
files are limited to 20000 characters. `duet pass --handoff` accepts only
regular files inside the bridge root.

Use `duet next` before acting when baton ownership is unclear. It reports
allowed-to-act state, warnings, static next-action hints, and the latest
recorded verifier summary without spending tokens.

Use `duet packet export --agent minimax` when the MiniMax side needs a compact
derived packet. Packet exports are local-only projections, not runtime state.

Use `duet step --dry-run` before any real duet step. It is local-only,
token-free, and validates status, baton, route/model or Codex CLI settings, and
estimated input tokens.

Run `duet step --agent minimax --yes` or `duet step --agent codex --yes` only
after explicit token-spending approval. MiniMax uses the review-only model path.
Codex uses a separate non-interactive `codex exec` process. Both write a pending
local handoff, apply it through hardened `duet pass`, and redact the answer by
default.

Use `duet loop --dry-run` to preview the autonomous loop without spending
tokens. It reports stop reasons, next agent, token estimate, limits, and
optional verifier configuration.

Run `duet loop --yes` only after explicit token-spending approval. It alternates
the current baton holder through hardened `duet step --agent <agent> --yes`,
optionally runs a verifier between running steps, and stops on terminal status,
limits, token budget, repeated handoff hash, apply failure, or verifier failure.

Use `duet report` after a loop or step sequence for a local-only redacted run
summary: current state, latest loop stop reasons, step counts, token usage,
verifier summaries, transcript hashes, and suggested continuation commands.

Use `duet transcript export` for a redacted JSON transcript. Add
`--format markdown --out .\duet-transcript.local.md` for a Markdown artifact.
Use `--raw` only when local goal, handoff, and journal text are intentionally
needed.

Use `duet verify --verifier <file>` to run a local Node verifier through the
bridge. Verifier output is redacted by default and home/profile plus
`NODE_OPTIONS` are cleared; `--record --agent codex|minimax` adds a compact
metrics-only note to an active Duet journal.

### Natural Language Start

If the user describes a task and ends with `let's go`, treat that as a request
to start or continue Duet Relay.

Expected behavior:

1. Create a compact `duet-goal.local.md` from the user's task.
2. If no relay exists, run `duet start` with yourself as the first baton holder.
3. Run `duet show`.
4. Do the next useful piece of work.
5. Write a compact handoff file.
6. Use `duet pass` to transfer the baton, or finish with `done` /
   `human_escalation`.

Do not run token-spending commands as part of `let's go` unless the user
explicitly approves that separate action.

`duet start` is local-only. It initializes the relay and returns recommended
`show`, `next`, `loop --dry-run`, `loop --yes`, and `report` commands, but it
does not run the autonomous loop.

Duet Relay records the baton and shared state. It does not wake, message, or
activate MiniMax automatically. To continue on MiniMax's side, the user must
open MiniMax or explicitly approve a separate `ask` / `mvs-send` step.

## Collaboration With MiniMax

Estimate before spending tokens:

```powershell
node .\bridge.mjs canary-estimate
```

Use a task file for review-only collaboration:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task path\to\task.md
node .\bridge.mjs ask --yes --mode review-only --task path\to\task.md --include path\to\source
```

By default, `ask` attaches `git status`, diffs, and text snippets for untracked
files so MiniMax can review local changes it cannot otherwise see. Inspect this
without spending tokens:

```powershell
node .\bridge.mjs ask --dry-run --raw --task path\to\task.md
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
