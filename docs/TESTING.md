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
- `maxIterations` stop behavior.
- Invalid arguments and oversized goal/handoff/note files.
- Damaged `duet-state.json` and missing `duet-journal.md`.
- Fresh and stale `duet.lock` behavior.
- Safe local commands: `help`, `config show`, `mode list`, `session show`,
  `deny-session list`, `token-stats --ledger`.
- `.gitignore` coverage for runtime files and duet atomic temp files.
- Installable skill and prompt surfaces documenting Duet Relay.

Token-spending commands are intentionally not covered by the offline suite:

- `ask`
- `mvs-send`
- `canary`
- `optimize-check` without `--skip-canary`

Run those only as explicit manual checks after user approval.
