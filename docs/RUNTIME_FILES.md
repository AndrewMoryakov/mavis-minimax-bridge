# Runtime Files

The bridge uses local runtime files in the repository root:

```text
config.json
ledger.jsonl
inbox.jsonl
outbox.jsonl
duet-state.json
duet-journal.md
duet.lock
duet-state.json.*.tmp
duet-journal.md.*.tmp
.codex-isolated-*.local/
```

They are intentionally ignored by git because they can contain local paths,
session ids, canary results, handoffs, and coordination history.

Initialize the base runtime files with:

```powershell
npm run init
```

or:

```powershell
node .\scripts\init-runtime.mjs
```

Use empty JSONL logs instead of scaffold notes:

```powershell
node .\scripts\init-runtime.mjs --empty-jsonl
```

`duet-state.json` and `duet-journal.md` are created by `duet init`, not by the
runtime initializer. `duet.lock` is a short-lived guard file created while a
duet command updates state. Atomic duet temp files may appear only if a process
dies mid-write. `.codex-isolated-*.local/` directories are disposable scratch
workspaces from interrupted isolated Codex runs. These files are ignored by git
and can be deleted after inspection.

Run `node .\bridge.mjs doctor` before workspace-sensitive commands if the shell
may be in another project. `doctor` is local-only and does not write runtime
files. Workspace guard failures also avoid runtime-file writes.

```powershell
node .\bridge.mjs duet init --goal .\duet-goal.local.md
```

Recreate base runtime files in another directory:

```powershell
node .\scripts\init-runtime.mjs --target C:\path\to\bridge-runtime
```

This only copies the runtime skeleton. The CLI uses the directory that contains
`bridge.mjs` as its active runtime root, so normal installs should run
`npm run init` from the cloned repository root.

Overwrite existing base runtime files only when you mean it:

```powershell
node .\scripts\init-runtime.mjs --force
```
