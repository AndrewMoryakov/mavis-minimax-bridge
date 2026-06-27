---
description: Use the local Mavis MiniMax Bridge from Codex
argument-hint: [doctor|status|audit|state|mode|session|tokens|ask|duet] [ARGS...]
---

Use the `mavis-minimax-bridge` skill and operate the local bridge repository.

User request or command arguments:

```text
$ARGUMENTS
```

Rules:

- First inspect bridge state with local-only commands when the request is vague;
  use `doctor` when the active shell may be in the wrong project.
- If the user describes a task and says `let's go`, treat it as a request to
  start or continue Duet Relay. Create a compact local goal/handoff file, run
  the appropriate `duet init/show/pass/note` commands, and keep working until
  `done` or `human_escalation`.
- Use `duet next` before acting when baton ownership is unclear.
- Use `duet packet export --agent minimax` when a compact derived packet is
  needed for the MiniMax side; packets are projections, not relay state.
- Use `duet step --agent codex|minimax --dry-run` before any real duet step; it
  is local-only and token-free.
- Use `duet step --agent minimax --yes` or `duet step --agent codex --yes` only
  after explicit token-spending approval; each runs one relay turn and applies
  the handoff.
- Use `duet loop --dry-run` to preview an autonomous loop without spending
  tokens.
- Use `duet loop --yes` only after explicit token-spending approval; it can run
  both Codex and MiniMax steps.
- Use token-spending commands only after explicit user approval.
- Never send to a guessed, burned, denied, or expensive `mvs_...` session.
- Prefer review-only collaboration before asking MiniMax for patch proposals.
- `ask` attaches bounded local Git source context for dirty worktrees by
  default; use `--dry-run --raw` to inspect it without spending tokens.
- Duet Relay commands are local-only except for explicit
  `duet step --agent minimax --yes`, `duet step --agent codex --yes`, and
  `duet loop --yes`. Use relay commands for baton-passing state, not arbitrary
  prompts.
- Duet Relay does not wake, message, or activate the other agent automatically.
- Duet output is redacted by default; use `--raw` only when the user explicitly
  needs local goal, handoff, or journal text in stdout.
- Use `duet verify --verifier <file>` for deterministic local verifier scripts;
  record only compact metrics into the journal with `--record --agent ...`.
- Report the commands run, whether tokens were spent, warnings, and next action.
