# Bridge Refactor Plan — Phase 2

Status: proposed (revised after a multi-agent safety review). Precondition done.

Continues `BRIDGE_REFACTOR_PLAN.md`, which is implemented through Patch 5 plus a
follow-up `path-security` extraction. Phase 1 moved leaf helpers into `lib/`
(`json`, `paths`, `config-core`, `duet-lock`, `duet-journal`, `path-security`),
~285 lines total. `bridge.mjs` is still the monolith (~4372 lines): HTTP/session
clients, source-context collection, Duet orchestration, the verifier runner, and
CLI dispatch all remain inline.

Same rules as Phase 1:

- No public CLI behavior changes.
- No module may import `bridge.mjs`.
- Keep `bridgeDir` semantics stable: it means the bridge runtime root.
- Every patch keeps `npm run test:release` green.
- Each extracted module gets its own test file before or during extraction.
- Boring, mechanical, one small patch at a time.

## Revision note

This plan was reviewed by a 5-dimension multi-agent pass (safety, coupling,
tests, sequencing, consistency) plus an opus synthesis. Verdict:
**safe-with-changes** — the direction is sound, but the original move lists were
materially inaccurate against `bridge.mjs` in ways that would make a literal
implementer either violate "no module imports `bridge.mjs`" or change observable
`ask --include` output. The corrections below fold in the six must-fixes. Cited
line numbers are approximate anchors, not contracts; re-grep before editing.

## Precondition: commit in-flight work first — DONE

The `--codex-mode` feature is committed (`535488f`, code + tests + docs + skills +
prompts, `npm run test:release` green). The working tree is clean apart from this
plan doc, so mechanical refactor patches no longer mix with an unfinished
feature.

## Candidate triage

The four "Later Candidates" from Phase 1, mapped to the real code and ranked by
coupling. **Correction:** `buildAskSourceContext` is NOT a leaf — it is the
widest-coupled function in either Patch-6/7 region. The pure leaves around it
are clean; the orchestrator on top of them is not.

| Candidate | Real location | Coupling | Verdict |
|-----------|---------------|----------|---------|
| source-context leaves (`shouldSkipSourceContextPath`, `readSourceSnippet`, `includedSourceFiles`) | ~485–650 | depend on `path`/`fs`, `comparablePath`/`isPathInsideRoot`/`realpathOrResolve` (already in `path-security`), `bridgeDir`, per-file limits, and `isProbablyText` (shared — see below) | take first (Patch 6) |
| `isProbablyText` (~432) | text/binary sniff | used by both `readSourceSnippet` (~535) and `readUntrackedSnippet` (~472, stays in `bridge.mjs`) — a general text util, NOT a source-context leaf | home in shared `lib/text-utils.mjs` (prep, lands before/with Patch 6) |
| verifier runner (`verifierArgs`, `validateForwardedVerifierArgs`, `resolveVerifierPath`, `verifierEnv`, `runVerifierProcess`) | ~3885–4060 | self-contained process runner — BUT `runVerifierProcess` pulls in `summarizeStream`/`killProcessTree`/`verifierMax*` consts/`now`, and `summarizeStream` needs `textDigest`/`textSummary` which are NOT verifier-local | take second (Patch 7, after a shared-summarizer prep) |
| `buildAskSourceContext` | ~653–769 | NOT a leaf: calls `runGit` (~403), `safeGitText` (~411), `appendBounded` (~415), `listUntrackedPaths` (~437), `readUntrackedSnippet` (~447), `relativeBridgePath` (~481), `argValue`/`argValues` (~242), reads the `config` singleton (`askSourceContextMode` ~654, `askMaxSourceContextChars` ~662) | keep in `bridge.mjs` for now (Patch 6b, optional later) |
| mvs-client (`fetchMavisJson`, `verifyMavisSession`, `createSession`, `sendPrompt`, `readUsage`) | ~906–1209 | HTTP + session + mutable `config` singleton; `writeConfig` mutates it (~46–53), risking a `config -> client -> config` cycle | defer — needs a config-write injection prep patch first |
| codex-runner (`runCodexExecTurn`, `codexWorkspaceForMode`, …) | ~2805–3526 | large, mixed (process spawn + workspace + Duet step glue) | defer on size/coupling grounds (see note) |

Deferral note: codex-runner's earlier "actively edited right now" reason is gone
now that `--codex-mode` is committed. The durable reason to defer is its size and
mixed concerns (it straddles process spawning, scratch-workspace setup, and Duet
step glue) — extract it only after a focused plan, not as a mechanical move.

## Patch 6: Extract `lib/source-context.mjs` (pure leaves only)

Purpose: move the pure file-snippet leaves out of `bridge.mjs`. These are a
genuine clean cut — half their dependency (`comparablePath` and friends) already
lives in `path-security`.

Move ONLY:

- `shouldSkipSourceContextPath`
- `readSourceSnippet`
- `includedSourceFiles`

Do NOT move `buildAskSourceContext` in this patch — see the triage table.

Do NOT home `isProbablyText` (~432) here. Confirmed breadth: it is used by both
`readSourceSnippet` (~535, moving here) AND `readUntrackedSnippet` (~472, which
stays in `bridge.mjs` under Patch 6b). Homing it in `source-context.mjs` would
force `bridge.mjs` to import from `source-context.mjs` (a lib-mishoming smell).
It is a general text util — put it in the shared text module (see the prep below)
and import it here. The prep must therefore land BEFORE or WITH Patch 6.

Injection interface:

```js
// bridge.mjs
const sourceContext = makeSourceContext({ bridgeDir, paths, limits });
```

- Mirror the Phase-1 `makePaths(bridgeDir)` pattern: `bridgeDir` is passed in,
  never recomputed from `import.meta.url` inside the module.
- `limits` must carry the configurable caps (`askMaxSourceContextChars` /
  per-file limit) so the module never imports the `config` singleton and the
  caps stay configurable — dropping them would be an observable behavior change.

Deny-list correction (important):

- `shouldSkipSourceContextPath` matches by **basename** (~488, ~496–504), so
  nested files like `examples/foo/config.json` are skipped today. Preserve that.
- `lib/paths.mjs` only covers ~7 of the ~13 deny entries and returns **absolute**
  paths. `.git`, `node_modules`, `live-smoke-`, `.env`, `.local.`, the
  `duet-(state|journal).json.*.tmp` regex (~505), and the hardcoded `examples/…`
  fixtures (~506–511) are NOT in `paths.mjs`.
- Derive the runtime-file deny entries as `path.basename(paths.X)` and match
  against the basename; keep the non-paths entries hardcoded in the module. Do
  NOT replace basename matching with absolute-path equality — that is a silent
  regression.

Tests — `tests/lib-source-context.test.mjs`:

- deny-list skip logic, including a **nested fixture** (`sub/config.json` is still
  skipped) to catch a basename→fullpath regression;
- per-file truncation at the configured limit;
- binary-looking files rejected via `isProbablyText` (explicit unit test — NUL
  content can't reach this through the CLI);
- symlink-escape: a path that resolves outside `bridgeDir` is rejected
  (`realpathOrResolve` runs BEFORE `isPathInsideRoot`, ~613–614/633–634 — a
  careless reorder would let symlinks escape).

Behavior gate (must be an automated test, not a manual check):

- Add a **golden-string** assertion over a deterministic explicit-`--include`
  fixture asserting the full `<source_context>` block byte-for-byte. Existing
  CLI tests only `assert.match` on fragments, so an ordering/wrapper regression
  would pass silently otherwise.
- Determinism: the `ask --include` path runs `buildAskSourceContext`, which
  shells out to git (`runGit`/`listUntrackedPaths`). In the sandbox the git
  state is not pinned, so untracked-scanning could make the golden string flaky.
  Use explicit file `--include` paths only and a sandbox with controlled or
  absent git state so untracked output cannot leak into the asserted block.
- `npm run test:release`.

## Patch 6b (optional, later): move `buildAskSourceContext`

Only if there is a reason to. It is an orchestrator, not a leaf. To move it
without importing `bridge.mjs`, enumerate and inject the full surface: `runGit`,
`safeGitText`, `appendBounded`, `listUntrackedPaths`, `readUntrackedSnippet`,
`relativeBridgePath`, `argValue`/`argValues`, plus the two config getters. Given
that surface, the cheaper default is to leave it in `bridge.mjs`.

## Shared-text prep (`lib/text-utils.mjs`) — lands before/with Patch 6

Two independent "looks-local-but-isn't" helpers must live in one shared module
so neither consumer (`source-context`, `verifier`) ends up importing the other:

- `isProbablyText` (~432) — used by `readSourceSnippet` (moves in Patch 6) and
  `readUntrackedSnippet` (stays in `bridge.mjs`). Needed by Patch 6, so this prep
  must land **before or with** Patch 6.
- `textDigest`/`textSummary` — ~37 uses across `bridge.mjs`; needed by
  `summarizeStream` in Patch 7. Moving them into `lib/verifier.mjs` would force
  `bridge.mjs` to import the verifier module (forbidden direction).

Extract all three into `lib/text-utils.mjs` (name chosen so it can hold both the
sniffer and the summarizers) with its own `tests/lib-text-utils.test.mjs`.
`summarizeStream` can move here too if it is otherwise pure; otherwise inject a
summarizer into the verifier module in Patch 7.

## Patch 7: Extract `lib/verifier.mjs`

Move:

- `verifierArgs`
- `validateForwardedVerifierArgs`
- `resolveVerifierPath`
- `verifierEnv`
- `runVerifierProcess`
- plus its direct deps: `killProcessTree`, the `verifierMax*` constants
  (~29–32), `now`, and the shared summarizer from the `lib/text-utils.mjs` prep.

Do NOT move `appendVerifyJournalEntry`. Correction: it is not a journal write —
it is a locked Duet-state transaction (~4064–4078): `withDuetLock` +
`readDuetState`/`writeDuetState` + `readDuetJournal`/`appendDuetJournal` + `now`,
and it enforces `state.status === 'running'` with an observable CLI error. That
is Duet orchestration, which both plans say to keep in `bridge.mjs`. (If it ever
must move, inject the full `{readDuetState, writeDuetState, withDuetLock,
appendDuetJournal, now}` surface — but prefer keeping it.)

Coupling to preserve:

- `resolveVerifierPath` uses `bridgeDir` as a security boundary with
  `realpathOrResolve` before `isPathInsideRoot` (~3911–3912) — same injected
  `bridgeDir` must reach it; add a symlink-escape test.
- `verifierEnv` (~3927–3947) is a clean move: it reads only `process.env`, blanks
  `HOME`/`USERPROFILE`/`NODE_OPTIONS`, and drops all non-allowlisted keys.

Tests — `tests/lib-verifier.test.mjs` (corrected descriptions):

- `validateForwardedVerifierArgs` rejects: arg **count > 256**, any arg
  containing a **NUL byte**, and any arg whose UTF-8 size exceeds **32 KiB**
  (~3893–3904). There is no "flag" concept — do not write a flag-name test, it
  would pass vacuously.
- `resolveVerifierPath` rejects a NUL byte (~3908) and any path resolving outside
  `bridgeDir` (symlink-escape).
- `verifierEnv` asserts the **security property**: `HOME`/`USERPROFILE`/
  `NODE_OPTIONS` are blanked and non-allowlisted keys are dropped.
- a stub verifier process yields the expected summary shape.

Checks:

- `duet verify` behavior unchanged.
- `npm run test:release`.

## Deferred (separate pass, each needs its own focused plan)

- `lib/mvs-client.mjs` — needs an explicit prep patch to make the config
  write-path injectable (`writeConfig` mutates the `config` singleton ~46–53)
  before the client can move without a `config -> client -> config` cycle.
- `lib/codex-runner.mjs` — defer on size/mixed-concerns grounds (above), not on
  "currently editing".

Never extract early (unchanged from Phase 1):

- CLI dispatch and `usage`.
- `duet step` / `duet loop` orchestration (and `appendVerifyJournalEntry`).

## Backlog (not Phase-2 gates)

Pre-existing, untested-before-and-after robustness gaps surfaced by the review —
track, do not block: verifier `spawn_error` path (~4041), stream-cap behavior
(~4021–4022), the "not a regular file" check (~3920). They are not Phase-2
regressions.

## Sequence

1. ~~Commit the in-flight `--codex-mode` feature~~ — done (`535488f`).
2. Shared-text prep — `lib/text-utils.mjs` (`isProbablyText`, `textDigest`,
   `textSummary`) + `tests/lib-text-utils.test.mjs`. Must precede Patch 6.
3. Patch 6 — `lib/source-context.mjs` (pure leaves, importing `isProbablyText`
   from `text-utils`) + tests, via TDD.
4. Patch 7 — `lib/verifier.mjs` + tests (summarizer already shared by step 2).
5. Pause for review. `mvs-client` (after a config-injection prep) and
   `codex-runner` in later focused passes.
