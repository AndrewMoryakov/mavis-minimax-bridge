# Testing

The default test suite is offline and deterministic. It does not call MiniMax,
does not run real `codex exec` steps, does not send prompts, and does not
require a live `mvs_...` session.

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
- `duet start` safe launch packet, redaction, recommended loop/report commands,
  and state initialization through the normal relay files.
- Redacted output by default and explicit `--raw` behavior.
- Raw output behavior for mutating Duet commands.
- `duet next` baton inspection, wrong-baton warnings, terminal states, redaction,
  and latest verifier summaries.
- `duet packet export` redaction, raw local output, path safety, agent
  validation, and visible truncation.
- `duet step --agent minimax --dry-run` baton/status validation, token estimate,
  redaction, raw prompt opt-in, and no ledger/model-call side effect.
- `duet step --agent codex --dry-run` baton/status validation, token estimate,
  redaction, Codex CLI settings, `exec`/`isolated` mode routing, and no
  ledger/agent-call side effect.
- `duet step --agent minimax --yes` offline fake-model path: successful handoff
  apply, redacted default output, pending handoff recovery on apply failure, and
  wrong-baton refusal before any model call.
- `duet step --agent codex --yes` offline fake-agent path: successful handoff
  apply, redacted default output, usage reporting, `codexMode` reporting, and
  baton transfer to MiniMax.
- `duet loop --dry-run` local preflight: next-agent preview, token budget stop,
  terminal stop, verifier config, required-agent validation, redaction, and no
  runtime-file mutation.
- `duet loop --yes` offline fake-agent path: successful terminal completion,
  repeated-handoff stop, verifier failure stop, redaction, actual token budget
  stop, required-agent `done` suppression, `human_escalation` passthrough, and
  summary counts.
- `duet report` redacted latest-loop summaries, transcript hashes, suggested
  next commands, and Markdown file output.
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
- `orchestrate status` local projection, malformed ledger warnings, ambiguous
  worker-tail detection, and default redaction.
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
- real `duet step --agent codex --yes` Codex CLI calls
- real `duet loop --yes` autonomous model/agent calls
- `npm run claude:smoke -- --yes`

Run those only as explicit manual checks after user approval. Offline `duet
step --agent minimax --yes` and `duet step --agent codex --yes` tests use an
internal fake reply and do not send prompts.

To record a live Claude Code smoke check without committing local evidence:

```powershell
npm run claude:smoke -- --yes --out claude-smoke-success.local.json
```

The command sends a tiny `Reply with OK only.` prompt through the bridge's
Claude adapter, prints a compact JSON result, and writes the same result to the
ignored `.local.json` file when `--out` is provided.

For a live two-agent smoke test, see
[`docs/DUET_ACCEPTANCE_TEST.md`](DUET_ACCEPTANCE_TEST.md). The live test uses
the same verifier but requires the human to open the other agent surface when
the baton is passed.

For a larger browser-game smoke test, see
[`docs/DUET_TETRIS_BROWSER_TEST.md`](DUET_TETRIS_BROWSER_TEST.md).
It includes both a minimal "Сделай тетрис" start and a directed acceptance
start.
