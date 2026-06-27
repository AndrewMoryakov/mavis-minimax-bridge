# Duet Guardrails Plan

## Goal

Make Duet Relay reliable for serious multi-agent review runs, especially when
the reviewed project is outside the bridge repository.

The bridge should stay thin. Do not turn it into a role engine or workflow
planner. Add small guardrails that prevent early terminal states, accidental
writes, and missing context.

## Background

The FreedomTunnelPlatform live validation exposed two gaps:

1. A Codex step can mark the relay `done` or `human_escalation` before MiniMax
   acts, even when the goal asks for both agents.
2. The separate Codex executor may not have read access to a target project
   outside the bridge workspace.

Goal-level instructions helped, but they are soft constraints. The bridge needs
lightweight policies and context adapters.

## Design Layers

### 1. Skills And Profiles

Add small prompt presets that can be attached to Duet packets.

Initial shape:

```powershell
node .\bridge.mjs duet start --goal .\goal.local.md --profile review
```

Future optional shape:

```powershell
node .\bridge.mjs duet start --goal .\goal.local.md --skill no-write --skill evidence --skill require-two-agents
```

`--profile review` should inject a compact skills block:

- read project instructions first: `AGENTS.md`, README, docs;
- review-only stance;
- findings first, ordered by severity;
- concrete evidence and file/path references;
- state what was checked and not checked;
- do not edit files;
- do not mark `done` before required participants have acted.

This is a soft constraint. It improves agent behavior but does not enforce
policy by itself.

`--profile` should be deterministic sugar over a fixed `--skill` set. Explicit
future `--skill` flags should compose with profiles; duplicates are ignored and
unknown skills are rejected.

### 2. Loop Hooks And Policies

Add small post-step policies to `duet loop`.

#### Required Participants

```powershell
node .\bridge.mjs duet loop --yes --require-agents codex,minimax
```

Behavior:

- Track which agents have successfully produced an applied step in this loop.
- If a step returns `Status: done` before all required agents acted, suppress
  the terminal status.
- Convert the terminal handoff into a `running` handoff to the next missing
  required agent, in the order passed to `--require-agents`.
- Record the suppression in ledger/report:
  - `suppressedTerminalStatus: done`
  - `suppressedFromAgent: "codex"`
  - `suppressedFromStepId: "<step-id>"`
  - `suppressedReason: "required_agents_missing"`
  - `requiredAgents: ["codex", "minimax"]`
  - `satisfiedAgents: ["codex"]`
  - `nextRequiredAgent: "minimax"`

`human_escalation` always remains terminal. It short-circuits
`--require-agents`, because it can indicate a real access, safety, or policy
blocker. The report should make the blocker visible.

An agent is satisfied only after a step is applied and survives all active loop
policies. A step that later triggers `policy_violation` does not satisfy the
agent requirement.

#### Readonly Watch

```powershell
node .\bridge.mjs duet loop --yes --watch-readonly "O:\user files\Projects\FreedomTunnelPlatform"
```

Behavior:

- Before loop: record baseline for watched path.
- After each step: compare `git status --short` when the path is a Git repo.
- V1 should be Git-only. Non-Git paths fail fast with a clear error. A later
  snapshot mode can use a bounded `(relativePath, size, mtimeUtc)` manifest plus
  optional file hashes for small text files.
- Stop on changes with `policy_violation:no_write`.
- Report changed paths in redacted/summarized form.
- Keep bridge scratch/context snapshots outside watched paths, so
  `--include-readonly` and `--watch-readonly` on the same target do not self-trip.

This is a hard policy. Review-only runs should not silently mutate target
projects.

#### Report Shape Checks

Optional later policy:

```powershell
node .\bridge.mjs duet loop --yes --require-report-shape review
```

Warn or stop when final handoff lacks:

- findings;
- checked/not checked;
- no-files-changed statement;
- residual risks.

This is out of the first guardrail wave unless implemented as a loop-level stop
condition (`policy_violation:report_shape`). Do not advertise a warning-only
check as a hard guardrail.

### 3. Readonly Context Adapter

Add bounded read-only source context for external project reviews.

```powershell
node .\bridge.mjs duet start `
  --goal .\goal.local.md `
  --include-readonly "O:\user files\Projects\FreedomTunnelPlatform" `
  --profile review
```

Behavior:

- Resolve and validate the path.
- Read only text files within strict limits.
- Exclude:
  - `.git`;
  - secrets and `.env` files except safe examples;
  - binaries;
  - build artifacts;
  - runtime folders;
  - huge files.
- Include a compact context packet:
  - target root summary;
  - `git status --short`;
  - `AGENTS.md`;
  - README/docs index;
  - solution/project manifests;
  - selected source/test file list;
  - small snippets from likely entry points.
- Mark context as read-only and potentially incomplete.
- Enforce per-tree caps, not only per-file caps. If the tree is too large,
  record `contextSkipped` with the reason.
- Re-check the final packet size before every `duet step`, not only at
  `duet start`.
- Surface context completeness/disclaimer fields in `duet report`, not only in
  the agent prompt.

This avoids relying on the child Codex executor having direct filesystem access
to the external project.

Context snapshots must be held in memory or in bridge-local scratch files outside
any watched target path.

## Implementation Order

### Patch 1: `--require-agents`

Implement the smallest hard guardrail first.

Scope:

- Parse `--require-agents codex,minimax` for `duet loop --dry-run` and
  `duet loop --yes`.
- Validate agent names.
- Add required/satisfied agent fields to dry-run and live output.
- In live loop, defer premature `done` when required agents are missing.
- Update `duet report` to show required/satisfied/deferred terminal status.
- Add offline fake-agent tests:
  - Codex returns `done`; loop defers to MiniMax.
  - MiniMax then returns `done`; final status becomes `done`.
  - `human_escalation` remains terminal.

### Patch 2: `--include-readonly`

Scope:

- Build bounded external context collector.
- Reuse existing source-context safety ideas from `ask --include`.
- Add packet section for read-only target context.
- Enforce per-tree caps and packet-size assertions before every step.
- Add report fields for context completeness and skipped paths/reasons.
- Add tests for path boundaries, binary skipping, secret skipping, symlink loops,
  file count/char caps, oversized `AGENTS.md`, and redaction.

### Patch 3: `--profile review`

Scope:

- Add profile parsing to `duet start`, `duet step`, `duet loop`, and packet
  creation.
- Treat `--profile review` as deterministic sugar for a fixed skill set.
- Inject compact review skills into packet/prompt.
- Document profile/skill composition rules.
- Add tests that dry-run packet hashes/metadata show profile is attached without
  leaking raw goal text.

### Patch 4: `--watch-readonly`

Scope:

- Add path validation.
- V1: require watched paths to be Git repos.
- Use `git status --short` baseline/diff.
- Add live loop stop reason `policy_violation:no_write`.
- Add report fields for watched paths and violations.
- Document that standalone `duet step` does not inherit loop policies unless the
  same policy flags are explicitly passed.
- Add tests using temporary Git repos and a same-path
  `--watch-readonly`/`--include-readonly` combination.

### Patch 5: Live Validation

Repeat the FreedomTunnelPlatform review scenario:

```powershell
node .\bridge.mjs duet start --goal .\freedom-review-goal.local.md --profile review --include-readonly "O:\user files\Projects\FreedomTunnelPlatform" --baton codex --max-iterations 18 --max-rounds 12 --max-codex-steps 6 --max-minimax-steps 6 --max-tokens 2500000 --force
node .\bridge.mjs duet loop --dry-run --require-agents codex,minimax --watch-readonly "O:\user files\Projects\FreedomTunnelPlatform" --max-rounds 12 --max-codex-steps 6 --max-minimax-steps 6 --max-tokens 2500000
node .\bridge.mjs duet loop --yes --require-agents codex,minimax --watch-readonly "O:\user files\Projects\FreedomTunnelPlatform" --max-rounds 12 --max-codex-steps 6 --max-minimax-steps 6 --max-tokens 2500000
node .\bridge.mjs duet report
```

Success criteria:

- both Codex and MiniMax act at least once;
- no target files changed;
- final report includes prioritized findings;
- if blocked, blocker is explicit and actionable.

Cost controls for live validation:

- use high enough `--max-tokens` for Codex context reality;
- add a future `--max-wall-minutes` before long unattended loops;
- include token and wall-clock usage in the final report.

## Required Tests

Add these across the patch series:

1. `--require-agents codex,minimax`: Codex returns `done`; loop suppresses it
   and routes to MiniMax.
2. MiniMax then returns `done`; final relay status becomes `done`.
3. Early `human_escalation` with missing required agents remains terminal and
   does not route to the next agent.
4. A step that triggers `policy_violation` does not satisfy a required agent.
5. Required-agent order follows the CLI order.
6. `--include-readonly` skips `.env`, private keys, binaries, huge files, and
   symlink loops.
7. `--include-readonly` records `contextSkipped` when tree caps are hit.
8. `--watch-readonly` rejects non-Git paths in V1 with a clear error.
9. `--watch-readonly` detects changes in a temporary Git repo.
10. `--watch-readonly` and `--include-readonly` on the same path do not self-trip.
11. `--profile review` expands to deterministic skills and composes with future
    explicit skills.
12. `duet report` includes required/satisfied/suppressed terminal and context
    completeness fields.

## Non-Goals

- No hard-coded project roles.
- No automatic background daemon.
- No silent token-spending commands.
- No broad filesystem access expansion for child agents.
- No raw secret/context dumping by default.
