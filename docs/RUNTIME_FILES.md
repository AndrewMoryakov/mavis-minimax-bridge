# Runtime Files

The bridge uses four local runtime files in the repository root:

```text
config.json
ledger.jsonl
inbox.jsonl
outbox.jsonl
```

They are intentionally ignored by git because they can contain local paths,
session ids, canary results, and coordination history.

Initialize them with:

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

Recreate files in another directory:

```powershell
node .\scripts\init-runtime.mjs --target C:\path\to\bridge-runtime
```

Overwrite existing files only when you mean it:

```powershell
node .\scripts\init-runtime.mjs --force
```
