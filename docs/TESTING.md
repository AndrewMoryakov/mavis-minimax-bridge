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
- `duet next` baton inspection, wrong-baton warnings, terminal states, redaction,
  and latest verifier summaries.
- `duet packet export` redaction, raw local output, path safety, agent
  validation, and visible truncation.
- `duet step --agent minimax --dry-run` baton/status validation, token estimate,
  redaction, raw prompt opt-in, and no ledger/model-call side effect.
- `duet step --agent minimax --yes` offline fake-model path: successful handoff
  apply, redacted default output, pending handoff recovery on apply failure, and
  wrong-baton refusal before any model call.
- Redacted and raw `duet transcript export`, including Markdown output and raw
  output path protection.
- `duet verify` verifier execution, redacted/raw output, non-zero exit codes,
  timeout handling, argument forwarding, path validation, and compact journal
  recording.
- `maxIterations` stop behavior.
- Explicit `human_escalation`.
- Wrong baton and invalid agent names.
- `duet pass` handoff path boundary and regular-file validation.
- Invalid arguments and oversized goal/handoff/note files.
- Malformed or damaged `duet-state.json`, missing `duet-journal.md`, and empty
  `duet-journal.md`.
- Fresh and stale `duet.lock` behavior.
- Lock cleanup after failed mutating commands.
- Safe local commands: `help`, `doctor`, `config show`, `mode list`,
  `session show`, `deny-session list`, `token-stats --ledger`.
- Workspace guard behavior for wrong-CWD `duet`, `ask`, and `--long-prompt`
  file inputs, including no runtime-file writes on guard failure.
- `ask --dry-run` source-context packaging for dirty Git worktrees.
- `state` visibility for Duet runtime files.
- `.gitignore` coverage for runtime files and duet atomic temp files.
- Installable skill and prompt surfaces documenting Duet Relay.
- Duet acceptance harness for `examples/duet-simple-orders`, using fake agents
  and the real local `duet` commands.
- Browser Tetris acceptance harness for `examples/duet-tetris-browser`, using
  fake agents and a mocked browser runtime.

Token-spending commands are intentionally not covered by the offline suite:

- `ask`
- `mvs-send`
- `canary`
- `optimize-check` without `--skip-canary`
- real `duet step --agent minimax --yes` model calls

Run those only as explicit manual checks after user approval. Offline `duet
step --agent minimax --yes` tests use an internal fake model reply and do not
send prompts.

For a live two-agent smoke test, see
[`docs/DUET_ACCEPTANCE_TEST.md`](DUET_ACCEPTANCE_TEST.md). The live test uses
the same verifier but requires the human to open the other agent surface when
the baton is passed.

For a larger browser-game smoke test, see
[`docs/DUET_TETRIS_BROWSER_TEST.md`](DUET_TETRIS_BROWSER_TEST.md).
It includes both a minimal "Сделай тетрис" start and a directed acceptance
start.
