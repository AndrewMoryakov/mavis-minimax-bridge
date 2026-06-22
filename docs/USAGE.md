# Usage

Initialize local runtime files:

```powershell
npm run init
```

This creates ignored local files: `config.json`, `ledger.jsonl`, `inbox.jsonl`,
and `outbox.jsonl`.

Common commands:

```powershell
node .\bridge.mjs status
node .\bridge.mjs canary-estimate
node .\bridge.mjs canary
node .\bridge.mjs optimize-check
node .\bridge.mjs optimize-check --session mvs_<id>
node .\bridge.mjs optimize-check --long-prompt .\stable-prefix.txt
node .\bridge.mjs ask --mode review-only --task .\task.md
```

Build a realistic local long-prompt file for cache-write canaries:

```powershell
npm run prefix:build
node .\bridge.mjs canary-estimate --long-prompt .\stable-prefix.local.txt
```

Safety notes:

- `mvs-send` requires `--yes` because it starts a model turn.
- `--long-prompt` is opt-in because it intentionally spends more tokens.
- Put burned, orchestration, or expensive sessions into `denySessions`.
- `ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local runtime files and
  should not be committed.
