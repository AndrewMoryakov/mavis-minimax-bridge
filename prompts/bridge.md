---
description: Use the local Mavis MiniMax Bridge from Codex
argument-hint: [status|audit|state|mode|session|tokens|ask|duet] [ARGS...]
---

Use the `mavis-minimax-bridge` skill and operate the local bridge repository.

User request or command arguments:

```text
$ARGUMENTS
```

Rules:

- First inspect bridge state with local-only commands when the request is vague.
- Use token-spending commands only after explicit user approval.
- Never send to a guessed, burned, denied, or expensive `mvs_...` session.
- Prefer review-only collaboration before asking MiniMax for patch proposals.
- Duet Relay commands are local-only. Use them for baton-passing state, not for
  sending prompts to MiniMax.
- Duet output is redacted by default; use `--raw` only when the user explicitly
  needs local goal, handoff, or journal text in stdout.
- Report the commands run, whether tokens were spent, warnings, and next action.
