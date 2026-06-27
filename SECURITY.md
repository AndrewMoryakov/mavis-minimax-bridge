# Security Policy

## Status

This project is experimental, Windows-first, and community-maintained. It is not
an official MiniMax product.

The bridge is a local JSONL workflow helper. It can talk to a locally running
MiniMax Code / OpenCode HTTP API and can read local Mavis usage data when a
session id is provided. It should be treated as a local operator tool, not as a
public network service.

## Supported Versions

Security fixes target the current `main` branch. Older commits are not
maintained as separate release lines.

## Reporting a Vulnerability

Please report security issues privately before opening a public issue if the
report includes:

- API keys, tokens, cookies, or account identifiers;
- private `mvs_...` session ids with sensitive context;
- local paths containing private project names;
- prompt, response, ledger, inbox, or outbox content from a real user session;
- a way to send unintended prompts to MiniMax Code;
- a way to expose local runtime data outside the machine.

Use GitHub private vulnerability reporting if available on the repository. If it
is not available, open a minimal public issue that says a private security
report is needed, without posting secrets or exploit details.

## Local Runtime Files

Do not commit or publish:

- `config.json`;
- `ledger.jsonl`;
- `inbox.jsonl`;
- `outbox.jsonl`;
- `duet-state.json`;
- `duet-journal.md`;
- `duet.lock`;
- `duet-state.json.*.tmp`;
- `duet-journal.md.*.tmp`;
- `*.local.*`;
- `.env`;
- MiniMax, Mavis, OpenRouter, or GitHub tokens.

These files are local runtime state. They may contain prompts, session ids,
usage observations, paths, relay handoffs, or other sensitive information.

## Safe Operation

- Keep the bridge bound to local workflows.
- Review task files before sending them to a MiniMax session.
- Prefer `review-only` and bounded prompts for collaboration checks.
- Use deny-session controls for burned or unsafe sessions.
- Do not run the bridge as an internet-facing service.

## Safe Testing

Prefer local checks first:

```powershell
node --check .\bridge.mjs
node .\bridge.mjs status
node .\bridge.mjs canary-estimate
node .\bridge.mjs optimize-check --skip-canary
```

Run live canaries only when the user accepts that they will send prompts to the
local MiniMax Code runtime.
