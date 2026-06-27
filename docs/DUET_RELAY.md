# Duet Relay: minimal Codex and MiniMax collaboration protocol

## Goal

Let Codex and MiniMax continue a task together after the human gives the initial goal.

The human should not have to repeatedly say "approved, continue" when another agent can review, challenge, and pass the work forward.

## Principle

Keep the protocol thin.

Do not hard-code detailed roles, stage machines, or project-specific workflows. Codex and MiniMax decide during the work who is better suited to plan, implement, review, investigate, or summarize.

The relay only preserves continuity and prevents runaway loops.

## Minimal State

Use one small state file and one journal:

- `duet-state.json`
- `duet-journal.md`

Example state:

```json
{
  "goal": "Complete the requested task",
  "baton": "codex",
  "iteration": 1,
  "maxIterations": 12,
  "status": "running",
  "lastHandoff": "",
  "humanEscalation": null
}
```

Required fields:

- `goal`: the human's objective.
- `baton`: who should act next, usually `codex` or `minimax`.
- `iteration`: current relay count.
- `maxIterations`: safety limit.
- `status`: `running`, `done`, or `human_escalation`.
- `lastHandoff`: compact summary for the next agent.
- `humanEscalation`: reason to stop and ask the human, if needed.

## Journal

The journal is the shared working memory.

It should stay compact and useful:

```md
# Duet Journal

## Goal

## Current State

## Decisions

## Done

## Open Questions

## Last Handoff
```

The journal records conclusions, not every thought.

## Turn Protocol

On each turn, the agent holding the baton:

1. Reads the state and journal.
2. Checks the previous handoff.
3. Does the next useful piece of work.
4. Verifies what it can verify.
5. Updates the journal.
6. Writes a compact handoff for the other agent.
7. Sets `baton` to the other agent, or sets `status` to `done` / `human_escalation`.

## Stop Conditions

Stop and return to the human when:

- the task is complete;
- required information or access is missing;
- a destructive or high-risk action needs approval;
- the agents disagree repeatedly and cannot resolve it;
- the relay reaches `maxIterations`;
- further work would be speculative or wasteful.

## Agent Guidelines

- Do not repeat the other agent's work unless checking it is valuable.
- Prefer concrete progress over meta-discussion.
- Keep handoffs short.
- Raise risks clearly.
- Continue without the human when the next step is safe and well-supported.
- Ask the human only for decisions the agents cannot infer from code, docs, or the stated goal.

## Non-Goals

This protocol is not:

- a rigid role system;
- a full workflow engine;
- a replacement for explicit human approval on dangerous actions;
- a guarantee of infinite autonomous work.

It is only a lightweight baton-passing convention.

## CLI

Initialize a relay from a goal file:

```powershell
node .\bridge.mjs duet init --goal .\duet-goal.local.md --baton codex --max-iterations 12
```

Show current relay state and the journal tail:

```powershell
node .\bridge.mjs duet show
```

By default this redacts relay content and prints sizes/hashes. Use
`duet show --raw` only when you intentionally need local goal, handoff, or
journal text in stdout.

Check who should act next:

```powershell
node .\bridge.mjs duet next
node .\bridge.mjs duet next --agent codex
node .\bridge.mjs duet next --agent minimax
```

`duet next` is local-only and redacted by default. It reports whether the
requested agent may act, terminal or wrong-baton warnings, static next-action
hints, and the latest recorded verifier summary.

Export a derived MiniMax packet projection:

```powershell
node .\bridge.mjs duet packet export --agent minimax
node .\bridge.mjs duet packet export --agent minimax --format markdown --out .\duet-packet.local.md
```

Packets are derived views of relay state and journal content. They are not a
new runtime artifact or state schema.

Preview a future MiniMax step without spending tokens:

```powershell
node .\bridge.mjs duet step --agent minimax --dry-run
```

The dry run validates baton ownership, status, iteration limits, packet size,
route/model, and estimated input tokens. It does not call MiniMax or advance the
relay.

Run one real MiniMax step:

```powershell
node .\bridge.mjs duet step --agent minimax --yes
```

`--yes` authorizes one review-only MiniMax model call and can spend tokens. The
bridge stores the model answer as a pending `.local.md` handoff, applies it via
the same hardened `duet pass` path, then returns the baton to Codex for
`Status: running` replies or stops on `done` / `human_escalation`. If applying
the handoff fails, state is not advanced and the pending path is returned.

Pass the baton after a turn:

```powershell
node .\bridge.mjs duet pass --from codex --to minimax --handoff .\handoff.local.md
```

Finish or escalate:

```powershell
node .\bridge.mjs duet pass --from minimax --status done --handoff .\handoff.local.md
node .\bridge.mjs duet pass --from minimax --status human_escalation --handoff .\handoff.local.md
```

Add a journal note without changing the baton:

```powershell
node .\bridge.mjs duet note --agent codex --note .\note.local.md
```

Goal, handoff, and note files are limited to 20000 characters each. The relay is
for compact handoffs, not archival dumps. `duet pass --handoff` accepts only
regular files inside the bridge root.

Duet commands are local-only except for explicit
`duet step --agent minimax --yes`, which calls MiniMax through the review-only
path and can spend tokens.
