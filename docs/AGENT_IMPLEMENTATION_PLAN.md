# Agent Implementation Plan

This plan describes how to implement the next bridge improvements with multiple
agents while keeping the Duet Relay philosophy thin: agents decide how to work,
the bridge only preserves state, safety, and verification boundaries.

## Scope

Implement, in this order:

1. `doctor` plus workspace guard.
2. `ask --include <path>`.
3. `duet transcript export`.
4. `duet verify`.
5. `duet smoke-start` design only.

`duet live-start` is out of scope for this pass. It would imply cross-surface
activation and token-spending behavior that needs a separate design review.

## Agent Model

Use short-lived agent ownership, not fixed global roles.

- The orchestrator owns sequencing, merges, and release gates.
- Explorer agents read code and docs, then produce constrained findings.
- Implementer agents edit only the files assigned to their phase.
- Reviewer agents check behavior, tests, docs, and safety assumptions.

Agents may swap functions between phases. The stable contract is the work
package, not the identity of the agent.

## Phase 0: Doctor And Workspace Guard

Purpose: prevent the repository-context desync that caused bridge work to drift
into an unrelated checkout.

Primary changes:

- Add `node .\bridge.mjs doctor`.
- Add `npm run doctor`.
- Guard workspace-sensitive commands before they read or mutate local runtime
  files.
- Keep help and `doctor` exempt from the guard.

`doctor` should be local-only, token-free, and non-mutating. It must not append
to `ledger.jsonl`.

Report fields:

- expected bridge root, derived from `bridge.mjs` location;
- current working directory;
- canonical root comparison;
- sentinel file checks;
- Git root diagnostics;
- verdict: `ok`, `warn`, or `fail`;
- next actionable command.

Guarded command groups:

- `duet *`;
- `ask`;
- `mvs-send --task`;
- file-input canary and optimize-check paths.

Implementation notes:

- Derive the expected root from `dirname(fileURLToPath(import.meta.url))`.
- Canonicalize paths with `fs.realpathSync.native` where available.
- Case-fold comparisons on Windows.
- Do not depend on the current Git root to decide the bridge root.

Tests:

- `doctor` succeeds from the bridge root.
- `doctor` warns or fails with useful JSON from another working directory.
- Guard blocks `duet` from the wrong working directory.
- Help and `doctor` stay usable from the wrong working directory.
- Test temp copies that contain only `bridge.mjs` produce warnings rather than
  false hard failures when the current directory is the copied bridge root.

Agent split:

- Explorer: map all file-sensitive commands.
- Implementer: add root detection, `doctor`, and guard plumbing.
- Reviewer: test Windows path, spaces, case, temp-copy, and no-ledger behavior.

## Phase 1: `ask --include <path>`

Purpose: let the user explicitly attach source context even when the worktree is
clean.

CLI contract:

```powershell
node .\bridge.mjs ask --yes --mode review-only --task .\task.md --include .\src
node .\bridge.mjs ask --dry-run --raw --task .\task.md --include .\docs\PLAN.md
```

Rules:

- `--include` is repeatable.
- Accept files and directories.
- Do not add glob support in v1.
- Reject missing paths, paths outside the bridge root, and symlink escapes.
- Skip `.git`, ignored runtime files, bridge task files, oversized files, and
  binary files.
- Share the existing bounded source-context budget.
- `--include` conflicts with `--source-context off`.
- `--dry-run --raw` must show the assembled prompt without spending tokens.

Implementation notes:

- Reuse the bounded snippet reader introduced for untracked source context.
- Normalize paths through a root-containment helper.
- Directory traversal should be deterministic.
- Include sections should identify whether a snippet came from explicit include
  or automatic dirty-worktree context.

Tests:

- Clean worktree plus include adds context.
- Dirty worktree plus include includes both context sources.
- Repeated `--include` works.
- Directory include is deterministic.
- Runtime/task files are excluded.
- `--source-context off --include ...` fails.
- Outside path, missing path, binary file, and symlink escape are rejected or
  skipped as appropriate.
- Truncation is visible in dry-run output.

Agent split:

- Explorer: identify existing source-context helpers and limits.
- Implementer: add parser, resolver, traversal, and prompt assembly changes.
- Reviewer: focus on prompt leakage and path-boundary tests.

## Phase 2: `duet transcript export`

Purpose: provide a safe artifact for reviewing or archiving a relay without
dumping raw local handoff text by default.

CLI contract:

```powershell
node .\bridge.mjs duet transcript export
node .\bridge.mjs duet transcript export --format markdown --out .\duet-export.local.md
node .\bridge.mjs duet transcript export --raw --out .\duet-export.local.json
```

Default behavior:

- JSON to stdout.
- Redacted relay text.
- Include public state, journal summary, and hashes/sizes.
- Do not include full goal, handoff, escalation text, or journal body.

Options:

- `--format json|markdown`.
- `--out <file>`.
- `--raw`.
- `--journal-lines <n>`.
- `--include-ledger`.
- `--ledger-lines <n>`.

Safety:

- Raw export to stdout is allowed only when the user explicitly passes `--raw`.
- Raw export to file should require an ignored or `.local.*`-style destination.
- Ledger export must summarize bridge entries and avoid exposing full prompts by
  default.

Tests:

- Redacted JSON stdout.
- Redacted Markdown stdout.
- Raw export contains expected local text only with `--raw`.
- Raw `--out` rejects unsafe tracked-looking paths.
- Ledger summaries do not expose full prompt text by default.

Agent split:

- Explorer: define redaction schema and ledger fields safe to expose.
- Implementer: add export command and formatters.
- Reviewer: compare raw and redacted output for accidental leakage.

## Phase 3: `duet verify`

Purpose: standardize local verification in Duet turns without encouraging shell
strings or ad hoc command execution.

CLI contract:

```powershell
node .\bridge.mjs duet verify --verifier .\examples\duet-tetris-browser\verify.mjs
node .\bridge.mjs duet verify --verifier .\verify.mjs --record --agent codex -- --fast
```

Rules:

- Run Node verifier files only: `.js`, `.mjs`, or `.cjs`.
- Use `spawnSync(process.execPath, [verifierPath, ...args], { shell: false })`.
- Support `--timeout-sec <n>`.
- Redact stdout/stderr by default with size, hash, and tail summaries.
- `--raw` prints exact stdout/stderr.
- `--record --agent codex|minimax` appends a compact verification note to the
  Duet journal.

Tests:

- Successful verifier returns success summary.
- Failing verifier returns non-zero status and useful summary.
- Non-Node verifier paths are rejected.
- Args after `--` are passed safely.
- Timeout is enforced.
- Output caps prevent noisy verifier output.
- `--record` writes a compact journal note.

Agent split:

- Explorer: inspect current example verifier scripts and acceptance tests.
- Implementer: add command, runner, output summary, and optional journal note.
- Reviewer: focus on no-shell execution, timeout, and redaction.

## Phase 4: `duet smoke-start` Design Only

Purpose: make live smoke tests easier later without prematurely building a
workflow engine.

This phase should produce a design document, not full implementation.

Candidate contract:

```powershell
node .\bridge.mjs duet smoke-start --template tetris-browser --out .\live-smoke-...
```

Design constraints:

- Local-only by default.
- No token-spending sends.
- No automatic MiniMax activation.
- Generates goal, acceptance checks, and verifier skeletons.
- Prints the exact next commands for Codex and MiniMax surfaces.
- Keeps generated directories ignored by default.

Review questions:

- Which templates are worth supporting first?
- How does smoke-start avoid becoming a project scaffold generator?
- Which outputs are committed docs versus local runtime artifacts?
- Should smoke-start be a separate script rather than a bridge command?

Agent split:

- Explorer: compare existing Tetris and simple-order smoke tests.
- Designer: write command contract and non-goals.
- Reviewer: reject any design that implies hidden token-spending or hard-coded
  agent roles.

## Global Gates

Before each phase is merged:

```powershell
npm run test:release
```

Also run targeted tests for the changed feature. For docs-only changes, at
minimum run:

```powershell
git diff --check
```

Token-spending commands must not be used in automated tests. Live `ask`,
`mvs-send`, `canary`, and full `optimize-check` require explicit human approval
for that run.

## Recommended Execution Order

1. Orchestrator opens a phase branch or local work item.
2. Explorer agent reports code touch points and risks.
3. Implementer agent edits only the assigned files.
4. Orchestrator runs targeted tests.
5. Reviewer agent checks behavior and safety assumptions.
6. Orchestrator fixes review findings.
7. Run `npm run test:release`.
8. Update docs and skill text if the CLI surface changed.
9. Commit and push.

## Risk Register

- Workspace desync: fixed first through `doctor` and guarded commands.
- Prompt leakage: every new export/include path must have redacted defaults.
- Token spending: no new command should start a model turn without existing
  explicit `--yes` style confirmation.
- Path traversal: all user-supplied paths must be root-contained after
  canonicalization.
- Runtime-file pollution: generated smoke and transcript files should be
  ignored or `.local.*` by default.
- Role creep: avoid encoding permanent Codex/MiniMax responsibilities in config.
- Hidden workflow engine: keep the relay a baton and journal, not a planner.

## Done Definition

The implementation pass is complete when:

- `doctor` catches wrong-root execution before sensitive commands run;
- `ask --include` can attach explicit bounded context from a clean worktree;
- `duet transcript export` produces safe redacted exports by default;
- `duet verify` can run deterministic local verifiers and optionally record the
  result;
- `duet smoke-start` has an accepted design or is explicitly deferred with
  rationale;
- docs and installed skill text describe the new commands;
- `npm run test:release` passes.
