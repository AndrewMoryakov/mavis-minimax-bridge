# Duet Acceptance Test

This repository includes one small verifiable task for checking the human-facing
Duet Relay workflow with two agents:

```text
examples/duet-simple-orders/
```

The task is intentionally boring. That is useful: success is objective and can
be checked by a script instead of by reading model prose.

## What It Checks

- A real task can be started from a compact goal.
- Codex and MiniMax can pass the baton through Duet Relay.
- The final artifact is checked by deterministic code.
- The relay reaches `done`.
- The journal records both Codex and MiniMax participation.

It does not prove that Duet Relay wakes the other agent automatically. It does
not. The human must open the other agent surface, or explicitly approve a
separate token-spending bridge command.

## Reset

From the repository root:

```powershell
Remove-Item .\duet-state.json, .\duet-journal.md, .\duet.lock -ErrorAction SilentlyContinue
Remove-Item .\examples\duet-simple-orders\answer.json -ErrorAction SilentlyContinue
```

## Start In Codex Or MiniMax

Paste this into either agent:

```text
Task:
Solve examples/duet-simple-orders/TASK.md.

Use Mavis MiniMax Bridge Duet Relay.
Start with yourself as the first baton holder.
Work safely, verify what you can, pass the baton to the other agent at least
once, and return to me only when the task is done or needs a real human
decision.

let's go
```

When the first agent passes the baton, open the other agent surface and ask:

```text
Continue the current Mavis MiniMax Bridge Duet Relay.
Read the relay state and journal, solve the next useful part of
examples/duet-simple-orders/TASK.md, verify the result, and finish only if the
acceptance check passes.

let's go
```

## Verify

Final verification:

```powershell
node .\examples\duet-simple-orders\verify.mjs
```

Intermediate answer-only verification, before the relay is marked `done`:

```powershell
node .\examples\duet-simple-orders\verify.mjs --skip-relay-check
```

Expected output:

```text
PASS duet-simple-orders
```

## Offline Regression

The automated offline test does not call Codex or MiniMax. It simulates two
fake agents using the real `duet` commands and then runs the same verifier.

```powershell
npm run test:offline
```
