# Restore After MiniMax Code Update Or Reinstall

Use this checklist after MiniMax Code updates, is repaired, or is reinstalled.
The bridge itself is a standalone local repository, but it depends on a running
MiniMax Code / Mavis environment.

## What Is Durable

- This GitHub repository.
- The bridge source, docs, examples, and scaffold files.

## What Is Local Runtime State

These files are intentionally ignored by git:

- `config.json`;
- `ledger.jsonl`;
- `inbox.jsonl`;
- `outbox.jsonl`;
- `duet-state.json`;
- `duet-journal.md`;
- `duet.lock`;
- `*.local.*`.

They may contain session ids, private paths, prompts, token observations, or
coordination history. `duet.lock` is transient and does not need backup. Back
up the other local files separately if you want to keep them across a machine
reinstall.

## Restore Commands

If the repository still exists:

```powershell
cd %USERPROFILE%\.mavis\agents\mavis\workspace\mavis-minimax-bridge
git pull
npm run init
node --check .\bridge.mjs
node .\bridge.mjs status
node .\bridge.mjs optimize-check --skip-canary
```

If the repository is missing:

```powershell
cd %USERPROFILE%\.mavis\agents\mavis\workspace
git clone https://github.com/AndrewMoryakov/mavis-minimax-bridge.git
cd mavis-minimax-bridge

npm run init
node --check .\bridge.mjs
node .\bridge.mjs status
node .\bridge.mjs optimize-check --skip-canary
```

`npm run init` creates the base runtime files without overwriting existing ones.
Duet relay files are created by `node .\bridge.mjs duet init --goal <file>`.
Use `node .\scripts\init-runtime.mjs --force` only when you intentionally want
to overwrite base runtime files.

## Restore Local State

If you backed up `config.json`, restore it after `npm run init`. If you backed
up an active relay, restore `duet-state.json` and `duet-journal.md` together.
Then check:

```powershell
node .\bridge.mjs state
node .\bridge.mjs mode list
node .\bridge.mjs session show
node .\bridge.mjs deny-session list
```

Set a current Mavis session only if the user gives a fresh valid `mvs_...`
session id:

```powershell
node .\bridge.mjs session set --session mvs_<id>
```

Keep burned or expensive sessions in the deny-list:

```powershell
node .\bridge.mjs deny-session add --session mvs_<id>
```

## Safe Verification

These commands do not intentionally send a model prompt:

```powershell
node .\bridge.mjs status
node .\bridge.mjs canary-estimate
node .\bridge.mjs optimize-check --skip-canary
```

Run live canaries or `mvs-send` only after user approval because they may spend
tokens.

## Related Restore Step

If MiniMax Code was updated, reapply the token optimizer first:

```powershell
cd %USERPROFILE%\.mavis\agents\mavis\workspace\minimax-code-token-optimizer
node .\scripts\install.mjs --profile max --reload
```
