# Duet Live Runbook

This is the practical human flow for a longer autonomous Codex and MiniMax run.
Use it when the human wants to give one compact goal, let the agents alternate
without approval between rounds, and inspect the result at the end.

The bridge still stays conservative:

- `duet start`, `duet loop --dry-run`, and `duet report` are local-only.
- `duet loop --yes` can spend Codex/OpenAI and MiniMax tokens.
- The live loop starts only after explicit human approval.
- Output is redacted by default; use raw transcript exports only when exact
  local goal, handoff, and journal text are intentionally needed.

## 1. Prepare The Goal

Create a compact goal file in the bridge root:

```powershell
Set-Content -Encoding UTF8 .\duet-goal.local.md @'
Task:
<describe the result you want>

Use Mavis MiniMax Bridge Duet Relay.
Codex and MiniMax should decide their own roles, plan, checks, and stopping
point. Continue without human input between rounds when the next step is safe.
Return to the human only when the result is done or a real human decision is
needed.
'@
```

Keep the goal specific enough to verify. Put large source context in the target
repository, not in the goal file.

## 2. Start The Relay

Run:

```powershell
node .\bridge.mjs duet start --goal .\duet-goal.local.md --baton codex --max-iterations 12 --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 120000
```

Use `--baton minimax` if MiniMax should make the first move.

`duet start` initializes `duet-state.json` and `duet-journal.md`, then prints a
redacted launch packet with the exact `show`, `next`, `loop --dry-run`,
`loop --yes`, and `report` commands to use next.

## 3. Preflight The Loop

Run the dry run from the launch packet:

```powershell
node .\bridge.mjs duet loop --dry-run --require-agents codex,minimax --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 120000
```

Check:

- `wouldRunLoop` is `true`.
- `nextStep.agent` is the expected baton holder.
- `stopReasons` is empty.
- `requirements.requiredAgents` matches the intended agent set.
- token estimate is acceptable for this task.

If you have a verifier:

```powershell
node .\bridge.mjs duet loop --dry-run --require-agents codex,minimax --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 120000 --verifier .\verify.mjs -- --fast
```

Verifier files must live inside the bridge root. They run from a scratch working
directory, so locate repository files via `import.meta.url` or absolute paths,
not `process.cwd()`.

## 4. Approve One Live Loop

After the dry run looks right, explicitly approve the token-spending loop:

```powershell
node .\bridge.mjs duet loop --yes --require-agents codex,minimax --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 120000
```

With a verifier:

```powershell
node .\bridge.mjs duet loop --yes --require-agents codex,minimax --max-rounds 8 --max-codex-steps 4 --max-minimax-steps 4 --max-tokens 120000 --verifier .\verify.mjs -- --fast
```

The bridge alternates the current baton holder through real agent steps and
stops on terminal status, max rounds, per-agent step limits, token budget,
repeated handoff hash, apply failure, or verifier failure. With
`--require-agents`, a premature `done` is recorded as suppressed and handed to
the next missing required agent; `human_escalation` remains terminal.

## 5. Read The Final Report

Run:

```powershell
node .\bridge.mjs duet report
node .\bridge.mjs duet report --format markdown --out .\duet-report.local.md
```

The report shows:

- final relay status and baton;
- latest loop stop reason;
- Codex/MiniMax step counts;
- observed token usage;
- verifier summaries;
- transcript hashes;
- suggested continuation commands.

If the relay stopped with `running`, inspect `stopReasons` and either continue
with another approved loop or finish/escalate manually.

## 6. Export A Transcript

For a compact artifact:

```powershell
node .\bridge.mjs duet transcript export --format markdown --out .\duet-transcript.local.md
```

For exact local text, only when intentionally needed:

```powershell
node .\bridge.mjs duet transcript export --raw --format markdown --out .\duet-transcript.local.md
```

Raw transcript exports can include the goal, handoffs, and journal text. Keep
them local unless the human explicitly decides otherwise.

## Resume Rules

- If the loop stopped on `max_rounds`, `max_codex_steps`, or
  `max_minimax_steps`, run `duet report`, then another `duet loop --dry-run`
  with updated limits.
- If it stopped on `actual_token_budget` or `token_budget`, raise
  `--max-tokens` only after the human accepts the cost.
- If it stopped on `verifier_fail`, inspect the verifier output summary and the
  journal before continuing.
- If it stopped on `step_apply_failed`, inspect the pending `.local.md` handoff
  path reported by the step result.
- If status is `done` or `human_escalation`, do not continue the loop; read the
  report and transcript.
