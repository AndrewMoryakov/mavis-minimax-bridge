# MiniMax Review: Codex Adapter Plan

Date: 2026-06-27

Reviewed document:

- `docs/CODEX_ADAPTER_PLAN_REVIEW.md`

Review mode:

- MiniMax `ask --mode review-only`
- Session: `ses_0f6b477baffeuNiGL6zMefyB91`
- Model: `minimax/MiniMax-M3`

## Verdict

Revise before approving.

The plan direction is correct, but Phase 5A success criteria are too soft, and
the current plan misses important safety gates around Codex invocation,
concurrency, secret scoping, verifier sandboxing, token budgets, and loop stop
conditions.

## Findings

### S1: Codex Invocation Is Not Proven

The plan assumes a standalone scriptable Codex executor may exist. This is not
yet proven. If there is no stable non-interactive Codex invocation surface, the
whole plan falls back to `codex_action_required`.

Required change:

- Phase 5A must explicitly support the outcome:
  "Codex has no scriptable non-interactive surface; stop, document, do not
  proceed to Phase 5B/5D."

### S2: Codex Session Concurrency Risk

Two Codex sessions in the same workspace may clobber relay files, pending
handoffs, ledger, journal, or source files.

Required change:

- Prove workspace isolation or use a separate worktree.
- Hold a filesystem-level lock across the whole Codex adapter lifetime.

### S3: Secret Scoping Is Missing

Relay packets may include secrets from prior handoffs, journal tail, verifier
output, or local paths.

Required change:

- Redact secrets before packet assembly, not only before stdout.
- Require explicit raw mode for any local packet artifact that contains raw text.

### S4: Loop Stop Conditions Are Underspecified

Missing definitions:

- repeated verifier failure threshold;
- token-budget stop;
- idle or hung adapter timeout;
- baton-advance detection;
- infinite ping-pong detection.

Required change:

- Define exact thresholds before implementing `duet loop`.

### S5: Long Tetris Gauntlet Acceptance Is Too Shallow

Current acceptance counts events but does not prove useful collaboration.

Required change:

- Validate handoff schema for every transition.
- Validate ledger/outbox event ordering.
- Require verifier coverage of at least two distinct invariants.
- Prove that each side consumes the previous handoff.
- Record transcript hash in the final report.

### S6: File Edit Risk Is Unaddressed

Codex adapter may edit files.

Required change:

- Protect `.env`, `.git`, `node_modules`, binary files, and large files.
- Canonicalize paths and block symlink/hardlink escape.
- Define write allowlist or denylist.

### S7: Verifier Sandbox Is Missing

Verifier scripts can be buggy or malicious.

Required change:

- Enforce timeout.
- Restrict filesystem scope.
- Disable or allowlist network and shell-out behavior.

### S8: Transcript Integrity Is Missing

Final transcript is not tamper-evident.

Required change:

- Use append-only JSONL with a per-event hash chain.
- Include transcript hash in final report.

### S9: Token Spending Limits Are Missing

`--yes` is not enough for long autonomous runs.

Required change:

- Add per-run and per-step token budgets.
- Include token spend in final report.
- Add kill-switch behavior for overspend.

### S10: Human Escalation Protocol Is Undefined

`human_escalation` is a stop condition, but resume semantics are not defined.

Required change:

- Define trigger format.
- Define notification/report shape.
- Define resume protocol, such as editing pending handoff and re-running with
  `--resume-from <id>`.

## Required Plan Changes

1. Phase 5A must stop if Codex invocation is unavailable or unstable.
2. Codex packets must be redacted before assembly and before disk writes.
3. Codex adapter must lock relay state for the whole adapter lifetime.
4. Codex execution must use canonical workspace roots and preferably a separate
   worktree.
5. Loop must define token, wall-clock, idle, verifier, and baton-advance limits.
6. Verifier execution must be sandboxed.
7. File edits need denylist or allowlist protection.
8. Final transcript must be tamper-evident.
9. Long Gauntlet acceptance must validate quality, not only event counts.
10. Human escalation and resume must be specified before loop implementation.

## Recommended Next Step

Run Phase 5A only.

Research commands:

```powershell
where.exe codex
codex --help
codex --version
```

Then attempt a tiny non-interactive Codex task in an ignored throwaway
directory. If that works, run a concurrency probe with two simultaneous dry-run
Codex invocations and verify workspace isolation.

Do not implement `duet loop` until Codex invocation is proven stable.

## Token Use

MiniMax review tokens:

- inputTokens: 13256
- outputTokens: 1324
- cacheRead: 128
- cacheWrite: 0
