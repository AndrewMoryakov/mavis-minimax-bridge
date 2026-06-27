# Codex Adapter Research

Date: 2026-06-27

Status: `supported_and_stable` for a bounded adapter prototype, with required
guardrails.

Related plan:

- `docs/CODEX_ADAPTER_PLAN_REVIEW.md`
- `docs/CODEX_ADAPTER_MINIMAX_REVIEW.md`

## Summary

Phase 5A proved that the local Codex CLI has a usable non-interactive
invocation surface:

```powershell
codex exec --cd <workspace> --sandbox <mode> --ephemeral --json --output-last-message <file> <prompt>
```

This is enough to proceed to Phase 5B, but the adapter must treat
`--output-last-message` as the primary result channel, not raw stdout/stderr.
The JSON stream and stderr can contain diagnostic noise even on successful
turns.

Recommended default:

```powershell
codex exec `
  --cd <canonical-workspace> `
  --sandbox workspace-write `
  --ephemeral `
  --ignore-user-config `
  --json `
  --output-last-message <pending-handoff-file> `
  <packet-prompt>
```

Use `read-only` for dry-run or analysis-only steps. Use `workspace-write` only
for a real Codex baton step.

## Environment

Observed CLI:

```text
codex-cli 0.142.2
```

Executable locations:

```text
C:\Users\hopt\AppData\Roaming\npm\codex
C:\Users\hopt\AppData\Roaming\npm\codex.bat
C:\Users\hopt\AppData\Roaming\npm\codex.cmd
```

`codex doctor` reported:

- ChatGPT auth is configured.
- Configured model is `gpt-5.5 · openai`.
- CLI update `0.142.3` is available.
- Some historic session files are malformed.
- Overall state was degraded but usable.

## Proven Behaviors

### Non-Interactive Read-Only Step

Probe:

```powershell
codex exec --cd <throwaway-dir> --sandbox read-only --ephemeral --json --output-last-message <out> -
```

Result:

- exit code: `0`
- last-message file created
- expected answer returned
- token usage appeared in JSON event stream

Finding:

- prompt via stdin works;
- `--output-last-message` is reliable for the final assistant message.

### Workspace-Write Step

Probe:

```powershell
codex exec --cd <throwaway-dir> --sandbox workspace-write --ephemeral --json --output-last-message <out> -
```

The child Codex process created a handoff file in the throwaway workspace and
returned `Status: done`.

Finding:

- `workspace-write` can create files;
- this is viable for a Codex duet baton step;
- bridge-side file boundaries are still required before enabling it in a loop.

### Parallel Invocations

Two simultaneous read-only `codex exec` processes were launched through
PowerShell jobs against the same throwaway directory.

Result:

- both jobs completed;
- both exit codes were `0`;
- both last-message files were created;
- each answer was isolated and correct.

Finding:

- concurrent CLI processes can run;
- the bridge must still hold the Duet lock across the whole adapter step,
  because relay files are shared mutable state;
- on Windows, use `codex.cmd` or a shell/job invocation, not the npm shim path
  without quoting.

### AGENTS.md Loading

A throwaway `AGENTS.md` required the marker
`CODEX_ADAPTER_AGENTS_LOADED` in the final answer.

With:

```powershell
codex exec --cd <throwaway-dir> --sandbox read-only --ephemeral --json --output-last-message <out> <prompt>
```

and with:

```powershell
codex exec --cd <throwaway-dir> --sandbox read-only --ephemeral --ignore-user-config --json --output-last-message <out> <prompt>
```

the child Codex answer included the marker.

Finding:

- local `AGENTS.md` files are loaded when `--cd` points at the intended
  workspace;
- `--ignore-user-config` does not disable local project instructions.

### `--ignore-user-config`

Without `--ignore-user-config`, stderr and sometimes the JSON stream contained
MCP authentication diagnostics from user-level connectors.

With `--ignore-user-config`, those diagnostics disappeared while local
`AGENTS.md` still loaded.

Finding:

- default adapter mode should include `--ignore-user-config`;
- this keeps spawned Codex closer to a deterministic local executor and avoids
  accidental access to user-level MCP tools.

## Important Caveats

### stderr Is Not Failure

Successful runs can still write diagnostics to stderr, including:

- `Reading additional input from stdin...`
- MCP `AuthRequired` errors when user config is loaded;
- Windows sandbox execution diagnostics from attempted tool calls.

Adapter rule:

- use process exit code plus expected last-message/pending-handoff file;
- preserve stderr for diagnostics;
- do not fail solely because stderr is non-empty.

### JSON Output Is Not Always Clean Enough

`--json` emits useful structured events, including token usage, but user-config
MCP diagnostics can appear outside the clean JSON event stream.

Adapter rule:

- parse JSON tolerantly line by line;
- ignore non-JSON diagnostic lines;
- treat `--output-last-message` as the authoritative final response.

### No Built-In Timeout Was Found

`codex exec --help` did not show a step timeout option.

Adapter rule:

- enforce timeout at the bridge process level;
- kill the child process tree on timeout;
- keep pending handoff only if a valid handoff file was produced.

### Approval Flag Differs From Interactive Codex

`codex exec` rejected `--ask-for-approval never`.

Adapter rule:

- do not pass interactive approval flags that are not supported by `exec`;
- use sandbox mode, `--ignore-user-config`, bridge policy, and process-level
  limits as the safety boundary.

### Correct Working Directory Is Critical

One local patch attempt landed in the old harness cwd instead of the bridge
root. The Codex CLI itself behaved correctly when `--cd` was explicit.

Adapter rule:

- canonicalize and pass `--cd` explicitly on every invocation;
- never rely on inherited process cwd.

## Recommended Phase 5B Contract

Add a Codex step adapter only after preserving the Phase 4B.2 MiniMax semantics:

```powershell
node .\bridge.mjs duet step --agent codex --dry-run
node .\bridge.mjs duet step --agent codex --yes
```

Phase 5B minimum:

- dry-run is local-only and token-free;
- live step requires `--yes`;
- live step uses `codex exec --ignore-user-config`;
- `--cd` is canonicalized;
- process timeout is enforced;
- async Duet lock is held from packet assembly through handoff apply;
- raw packet/output text is redacted by default;
- valid Codex output is saved as `.duet-step-codex-*.pending.local.md`;
- handoff is applied only through hardened `duet pass`;
- apply failure keeps the pending handoff and does not advance baton;
- stdout reports redacted summary, token usage when parsed, and diagnostics
  paths.

## Recommended Defaults

Initial defaults for implementation:

- sandbox: `workspace-write` for `--yes`, `read-only` for `--dry-run`;
- config: `--ignore-user-config`;
- session: `--ephemeral`;
- timeout: 10 minutes per Codex step;
- packet input: prompt argument or stdin, but avoid ambiguous quoting on
  Windows by using a temporary packet file or stdin;
- result: `--output-last-message` to a pending local file;
- JSON: parse only for usage and event diagnostics, tolerant of non-JSON lines.

## Decision

Phase 5A outcome:

```text
supported_and_stable
```

Proceed to Phase 5B: implement `duet step --agent codex --dry-run` and the
Codex invocation wrapper behind a live-step gate.

Do not implement `duet loop` yet. The loop still depends on the Codex step
adapter, file-boundary checks, token budgets, and timeout handling.
