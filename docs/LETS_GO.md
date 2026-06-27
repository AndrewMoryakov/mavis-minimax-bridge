# Let's Go

This is the human-facing way to start Duet Relay.

You should be able to open Codex or MiniMax, describe the task, and end with:

```text
let's go
```

The agent should then run the local Duet Relay setup itself.

Important: Duet Relay records the baton and shared state. It does not wake,
message, or activate the other agent automatically. To continue on the other
side, open that agent's surface and ask it to continue the current Duet Relay,
or explicitly approve a separate token-spending `ask` / `mvs-send` step.

## Prompt To Codex Or MiniMax

```text
Task:
<describe the task here>

Use Mavis MiniMax Bridge Duet Relay.
Start with yourself as the first baton holder.
Work safely, verify what you can, pass the baton to the other agent when useful,
and return to me only when the task is done or needs a real human decision.

let's go
```

## What The Agent Should Do

When an agent sees a task like this:

1. Go to the bridge repository.
2. Create a compact `duet-goal.local.md` from the user's task.
3. If no relay exists, run:

```powershell
node .\bridge.mjs duet init --goal .\duet-goal.local.md --baton codex --max-iterations 12
```

Use `--baton minimax` if MiniMax is starting.

4. Read current relay state:

```powershell
node .\bridge.mjs duet show
```

5. Do the next useful piece of work.
6. Write a compact handoff file.
7. Pass the baton:

```powershell
node .\bridge.mjs duet pass --from codex --to minimax --handoff .\handoff.local.md
```

or:

```powershell
node .\bridge.mjs duet pass --from minimax --to codex --handoff .\handoff.local.md
```

8. If the task is complete:

```powershell
node .\bridge.mjs duet pass --from codex --status done --handoff .\handoff.local.md
```

9. If a real human decision is needed:

```powershell
node .\bridge.mjs duet pass --from codex --status human_escalation --handoff .\handoff.local.md
```

## Safety

- Duet commands are local-only.
- They do not call MiniMax and do not spend tokens.
- Duet Relay does not wake, message, or activate the other agent automatically.
- Sending a prompt to MiniMax still requires explicit use of `ask` or `mvs-send`
  and explicit user approval.
- Default Duet output is redacted. Use `--raw` only when the user explicitly
  asks for local goal, handoff, or journal text.
- Keep goal and handoff files compact.
