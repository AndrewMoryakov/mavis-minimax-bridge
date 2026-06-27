# Bridge Refactor Plan

Status: accepted plan, not implemented yet.

Goal: reduce the size and coupling of `bridge.mjs` without changing public CLI
behavior. Every patch must keep `npm run test:release` green.

Current shape:

- `bridge.mjs` is the CLI entrypoint and currently contains runtime paths,
  config, JSON helpers, Mavis/MiniMax client code, source-context collection,
  Duet Relay, verifier execution, and CLI dispatch.
- Runtime files are not hardcoded to one machine. They are derived from the
  location of `bridge.mjs`:

  ```js
  const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.join(bridgeDir, "config.json");
  ```

- The risk is architectural, not portability-related: these paths are global
  entrypoint state. Refactoring must preserve the meaning of `bridgeDir` as the
  bridge runtime root.

## Refactor Rules

- No public CLI behavior changes in this series.
- No module may import `bridge.mjs`.
- Keep `bridgeDir` semantics stable: it means the bridge root/runtime root, not
  the directory of whichever helper module is executing.
- Do not compute the runtime root inside `lib/paths.mjs` with
  `dirname(fileURLToPath(import.meta.url))`; inside `lib/paths.mjs` that would
  point at `lib/`, not the bridge root.
- Preferred paths shape:

  ```js
  // bridge.mjs
  const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
  const paths = makePaths(bridgeDir);
  ```

- Do not move `printJson` into generic JSON helpers while it depends on
  `config.asciiConsole`.
- Do not extract the Duet loop/step orchestrator or CLI dispatch in the first
  series. Those are integration surfaces.

## Hidden Coupling

- `config` is a mutable singleton loaded at module startup.
- `writeConfig` mutates the existing `config` object and writes a ledger event.
  Replacing the object would risk stale references in existing imports.
- `configLoadError` is visible in `doctor`, so it is observable CLI state.
- `appendJsonl` depends on `now`; config writing depends on `appendJsonl`.
  Avoid import cycles such as `config -> json/logging -> config`.
- `doctor`, workspace guard, `--include`, handoff, verifier, and output path
  checks use `bridgeDir` as a security boundary.
- Existing CLI tests copy `bridge.mjs` into a temporary sandbox. After modules
  are introduced, the sandbox must also copy `lib/**`.

## Patch Order

### Patch 1: Sandbox Harness Only

Purpose: make tests ready for modular files before the first runtime extraction.

Changes:

- Update `tests/bridge-cli.test.mjs` sandbox helpers to copy `lib/**` alongside
  `bridge.mjs` when `lib/` exists.
- Keep tests working before `lib/` exists.
- Add/adjust tests proving runtime files are still written to sandbox root, not
  to the source repository and not to `lib/`.

Checks:

- `node .\bridge.mjs status` works from a sandbox copy.
- `duet init` in sandbox writes `duet-state.json`, `duet-journal.md`, and
  `ledger.jsonl` to sandbox root.
- `duet init` in sandbox does not create `lib/duet-state.json`,
  `lib/duet-journal.md`, `lib/ledger.jsonl`, or `lib/config.json`.
- Paths with spaces still work.
- Wrong-cwd guard still blocks workspace-sensitive commands without writing
  runtime files.
- `npm run test:release`.

### Patch 2: Extract JSON/Text Helpers

Purpose: move low-risk leaf helpers first.

New file:

- `lib/json.mjs`

Move:

- `readJson`
- `readJsonFromString`
- `stableStringify`
- `readJsonl`
- `escapeNonAscii` if it stays pure

Do not move yet:

- `printJson`, because it currently reads `config.asciiConsole`.
- `appendJsonl`, unless it is extracted as a separate event-log helper with an
  explicit `now` dependency. In current `bridge.mjs`, `appendJsonl` injects
  `ts: now()`, so moving it into generic JSON helpers would hide a logging/time
  dependency.

Tests:

- Add `tests/lib-json.test.mjs`.
- Cover JSON read fallback, stable stringification newline, JSONL read, and
  malformed JSON fallback.
- `npm run test:release`.

Optional later helper:

- `lib/event-log.mjs` or `lib/jsonl-log.mjs` can own `appendJsonl`.
- If extracted, use dependency injection:

  ```js
  appendJsonl(filePath, event, { now });
  ```

### Patch 3: Extract Runtime Paths

Purpose: centralize path construction without changing root semantics.

New file:

- `lib/paths.mjs`

Shape:

```js
export function makePaths(bridgeDir) {
  return {
    bridgeDir,
    configPath: path.join(bridgeDir, "config.json"),
    inboxPath: path.join(bridgeDir, "inbox.jsonl"),
    outboxPath: path.join(bridgeDir, "outbox.jsonl"),
    ledgerPath: path.join(bridgeDir, "ledger.jsonl"),
    duetStatePath: path.join(bridgeDir, "duet-state.json"),
    duetJournalPath: path.join(bridgeDir, "duet-journal.md"),
    duetLockPath: path.join(bridgeDir, "duet.lock"),
  };
}
```

Rules:

- `bridge.mjs` computes `bridgeDir`.
- `lib/paths.mjs` does not use `import.meta.url` to infer runtime root.
- Keep path-security helpers near their tests before moving them.

Checks:

- Sandbox runtime files still land in sandbox root.
- `doctor` reports the expected bridge root.
- `--include`, handoff, verifier, and output path escape tests remain green.
- `npm run test:release`.

### Patch 4: Config Extraction, Narrow Version

Purpose: reduce config coupling without creating a second config singleton or
import cycle.

Do not start with a full config move.

Safer first move:

- Extract pure config helpers only, or use dependency injection for side effects.
- Candidate file: `lib/config-core.mjs`.

Move first:

- `defaultConfig`
- `normalizeConfig`
- `validateNumberRange`
- `validateConfig`
- `parseConfigValue` if it has no bridge-side dependencies

Keep in `bridge.mjs` initially, unless injected explicitly:

- `config`
- `configLoadError`
- `loadInitialConfig`
- `writeConfig`
- `printJson`

If `writeConfig` is later extracted, its shape should avoid direct ledger/config
cycles:

```js
writeConfig(next, {
  configPath,
  currentConfig,
  appendEvent,
  reason,
});
```

Tests:

- Invalid `config.json`: `doctor` reports `loaded:false` and `verdict:"fail"`
  without crashing.
- `config set --key asciiConsole --value false` updates file and ledger.
- `mode set`, `session set/clear`, and `deny-session add/remove` are visible to
  following commands.
- Invalid config values do not write `config.json` and do not append
  `config-updated`.
- Sandbox and paths-with-spaces read/write local config and ledger.
- `asciiConsole:true` still escapes non-ASCII JSON output.
- `npm run test:release`.

### Patch 5: Narrow Duet Helpers

Purpose: extract small Duet leaves, not orchestration.

Candidates:

- `lib/duet-lock.mjs`
- `lib/duet-journal.mjs`

Allowed:

- lock acquire/release with `duetLockStaleMs`
- journal read/append helpers

Keep in `bridge.mjs` for this series:

- Duet step/loop orchestration
- agent runners
- transcript/report/packet rendering unless extracted as a separate later plan

Tests:

- Existing lock tests remain green.
- Add direct tests for stale lock behavior if the helper becomes independently
  importable.
- Journal append preserves markdown shape and redaction-sensitive commands still
  do not leak text by default.
- `npm run test:release`.

## Later Candidates

After the first five patches:

- `lib/source-context.mjs`
- `lib/mvs-client.mjs`
- `lib/verifier.mjs`
- `lib/codex-runner.mjs`

Each of these needs its own focused test file before or during extraction.

Do not extract early:

- CLI dispatch and `usage`
- `duet step` / `duet loop` orchestration
- mixed modules that combine config, paths, HTTP, and Duet behavior

## Review Sources

This plan incorporates:

- Codex local inspection of `bridge.mjs` and CLI tests.
- MiniMax review-only feedback.
- Additional subagent review focused on paths/sandbox/root semantics.
- Additional subagent review focused on config singleton and import cycles.
