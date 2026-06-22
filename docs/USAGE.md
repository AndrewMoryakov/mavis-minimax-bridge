# Usage

Copy the example config if you need local overrides:

```powershell
Copy-Item .\examples\config.example.json .\config.json
```

Common commands:

```powershell
node .\bridge.mjs status
node .\bridge.mjs canary
node .\bridge.mjs optimize-check
node .\bridge.mjs optimize-check --session mvs_<id>
node .\bridge.mjs optimize-check --long-prompt .\stable-prefix.txt
node .\bridge.mjs ask --mode review-only --task .\task.md
```

Safety notes:

- `mvs-send` requires `--yes` because it starts a model turn.
- `--long-prompt` is opt-in because it intentionally spends more tokens.
- Put burned, orchestration, or expensive sessions into `denySessions`.
- `ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local runtime files and
  should not be committed.
