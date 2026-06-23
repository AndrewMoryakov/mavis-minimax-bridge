# Contributing

Thanks for helping improve Mavis MiniMax Bridge.

This project provides a local JSONL bridge for controlled collaboration between
Codex-style agents and MiniMax Code. Contributions should preserve the core
property of the tool: explicit, inspectable, local-first coordination.

## Development Setup

```powershell
git clone https://github.com/AndrewMoryakov/mavis-minimax-bridge.git
cd mavis-minimax-bridge
node --check .\bridge.mjs
node .\bridge.mjs status
```

MiniMax Code should already be installed and running if you want to test live
OpenCode or Mavis session commands.

## Before Opening a Pull Request

Run:

```powershell
node --check .\bridge.mjs
node .\bridge.mjs status
node .\bridge.mjs canary-estimate
node .\bridge.mjs optimize-check --skip-canary
```

If your change sends prompts or touches live session commands, document the live
test you ran and the session safety assumptions.

## Contribution Guidelines

- Do not commit `config.json`, `ledger.jsonl`, `inbox.jsonl`, `outbox.jsonl`,
  `*.local.*`, `.env`, API keys, or session logs.
- Keep bridge commands explicit; avoid hidden background sends.
- Prefer dry-run, estimate, status, and audit commands before live canaries.
- Keep prompts compact and bounded.
- Preserve the local JSONL file model for runtime state.
- Add README updates when adding commands, modes, config keys, or output fields.
- Do not make the bridge an internet-facing service.

## Good First Contributions

- Improve command help text.
- Add safer validation for config fields.
- Improve audit summaries and token-stat explanations.
- Add examples under `examples/`.
- Improve documentation for first-time MiniMax Code users.

## Review Expectations

Pull requests should explain:

- what workflow is improved;
- whether the change reads or writes local runtime files;
- whether it can send prompts to MiniMax Code;
- what commands were run for verification;
- any privacy or token-cost implications.

Small, transparent changes are preferred over broad orchestration changes.
