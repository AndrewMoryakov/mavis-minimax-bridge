# Mavis MiniMax Bridge

Local JSONL bridge for controlled collaboration between Codex-style agents and
MiniMax Code / Mavis.

The bridge talks to the Desktop-owned `opencode serve` HTTP API and, when a
real `mvs_...` session id is supplied, can also query `mavis usage session` for
token metrics.

## Status

Experimental, Windows-first, and intentionally conservative. It is designed for
short coordination, review-only turns, and token-optimization canaries. It is
not a daemon and it does not ship secrets, ledgers, or MiniMax vendor code.

## Install

Clone the repository, then optionally create a local config:

```powershell
git clone https://github.com/AndrewMoryakov/mavis-minimax-bridge.git
cd mavis-minimax-bridge
npm run init
node .\bridge.mjs status
```

This creates the local runtime skeleton:

```text
config.json
ledger.jsonl
inbox.jsonl
outbox.jsonl
```

These files are ignored by git. Keep local session ids, paths, deny-lists, and
coordination history there.

## Commands

```powershell
node .\bridge.mjs status
node .\bridge.mjs canary
node .\bridge.mjs optimize-check
node .\bridge.mjs optimize-check --session mvs_<id>
node .\bridge.mjs optimize-check --long-prompt path\to\stable-prefix.txt
node .\bridge.mjs ask --mode review-only --task path\to\task.md
node .\bridge.mjs mvs-status --session mvs_<id>
node .\bridge.mjs mvs-peers --session mvs_<id>
node .\bridge.mjs mvs-messages --session mvs_<id> --limit 5
node .\bridge.mjs mvs-send --session mvs_<id> --task path\to\task.md --yes
node .\bridge.mjs tail
```

## Token Optimizer Check

`optimize-check` verifies:

- main route is direct `minimax/MiniMax-M3`;
- non-main lifecycle roles are routed to `openrouter/...`;
- a tiny two-turn canary can complete;
- response metadata reports provider/model/cache counters when available;
- optional `mavis usage session mvs_<id> --json` stays under `maxInputTokens`.

`cacheWriteObserved=false` does not automatically fail the verdict. Provider
cache reporting can remain zero on tiny prompts. Use `--long-prompt <file>`
only when you intentionally want a cache-write canary.

## Safety

- `mvs-send` requires `--yes` because it starts a model turn.
- `--long-prompt` is opt-in because it spends more tokens.
- Put burned, orchestration, or expensive sessions in `denySessions`.
- `ledger.jsonl`, `inbox.jsonl`, and `outbox.jsonl` are local audit files and
  are ignored by git.
- stdout escapes non-ASCII by default for legacy Windows admin consoles, while
  JSONL files are written as UTF-8.

See [docs/RUNTIME_FILES.md](docs/RUNTIME_FILES.md) for the runtime file
contract.

## Related

This bridge was split out from the MiniMax token optimization work:

https://github.com/AndrewMoryakov/minimax-code-token-optimizer
