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
node .\bridge.mjs state
node .\bridge.mjs config show
node .\bridge.mjs mode list
node .\bridge.mjs mode set --profile max --prompt-cache enforce --context-budget enforce
node .\bridge.mjs session set --session mvs_<id>
node .\bridge.mjs deny-session add --session mvs_<id>
node .\bridge.mjs token-stats --ledger
node .\bridge.mjs token-stats --session mvs_<id>
node .\bridge.mjs canary-estimate
node .\bridge.mjs canary --yes
node .\bridge.mjs optimize-check --skip-canary
node .\bridge.mjs optimize-check --yes --session mvs_<id>
node .\bridge.mjs optimize-check --yes --long-prompt .\stable-prefix.txt
node .\bridge.mjs ask --yes --mode review-only --task .\task.md
```

Build a realistic local long-prompt file for cache-write canaries:

```powershell
npm run prefix:build
node .\bridge.mjs canary-estimate --long-prompt .\stable-prefix.local.txt --repeat-long 2
```

Safety notes:

- `ask`, `canary`, `mvs-send`, and full `optimize-check` require `--yes`
  because they start a model turn.
- Prefer `mvs-send --task`; inline `--content` also requires
  `--allow-inline-content` because shells can retain command history.
- `--long-prompt` is opt-in because it intentionally spends more tokens.
- Put burned, orchestration, or expensive sessions into `denySessions`.
- `ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local runtime files and
  should not be committed.
