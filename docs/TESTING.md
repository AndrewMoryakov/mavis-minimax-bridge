# Testing

The default test suite is offline and deterministic. It does not call MiniMax,
does not send prompts, and does not require a live `mvs_...` session.

Run all local release checks:

```powershell
npm run test:release
```

This runs:

```powershell
npm run check
npm run test:offline
git diff --check
```

Run only the Node test suite:

```powershell
npm run test:offline
```

The tests copy `bridge.mjs` into a temporary directory for each CLI scenario.
That keeps real repository runtime files untouched.

Covered areas:

- Duet lifecycle: `init`, `show`, `pass`, `note`, `done`.
- Redacted output by default and explicit `--raw` behavior.
- Raw output behavior for mutating Duet commands.
- `maxIterations` stop behavior.
- Explicit `human_escalation`.
- Wrong baton and invalid agent names.
- Invalid arguments and oversized goal/handoff/note files.
- Malformed or damaged `duet-state.json`, missing `duet-journal.md`, and empty
  `duet-journal.md`.
- Fresh and stale `duet.lock` behavior.
- Lock cleanup after failed mutating commands.
- Safe local commands: `help`, `config show`, `mode list`, `session show`,
  `deny-session list`, `token-stats --ledger`.
- `state` visibility for Duet runtime files.
- `.gitignore` coverage for runtime files and duet atomic temp files.
- Installable skill and prompt surfaces documenting Duet Relay.

Token-spending commands are intentionally not covered by the offline suite:

- `ask`
- `mvs-send`
- `canary`
- `optimize-check` without `--skip-canary`

Run those only as explicit manual checks after user approval.
