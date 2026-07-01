# Orchestrator

`orchestrate` is the supervised "do it end to end" mode. One LLM acts as the
router and decides which worker should act next. Workers can be `codex`,
`minimax`, and optionally `claude`.

It is local and supervised. `--yes` allows the loop to spend model tokens until
it reaches `done`, `human_escalation`, or a budget cap. You can interrupt it with
Ctrl+C. If interruption happens during a worker turn, `resume` shows the
ambiguous pending turn and does not rerun it silently.

## Start Safely

Create a compact task file in the bridge repository:

```powershell
notepad .\task.local.md
```

Preview without spending tokens:

```powershell
node .\bridge.mjs orchestrate start --task .\task.local.md --target C:\path\to\project --dry-run
```

Run:

```powershell
node .\bridge.mjs orchestrate start --task .\task.local.md --target C:\path\to\project --yes
```

Use Claude as an extra worker when available:

```powershell
node .\bridge.mjs orchestrate start --task .\task.local.md --target C:\path\to\project --agents codex,minimax,claude --yes
```

## Where Results Go

The bridge does not auto-merge into your project.

- Git target: creates a task `git worktree` under `orch-artifacts/worktrees/`.
- Non-git target: creates a copy under `orch-artifacts/workspaces/`.

Review the workspace when the run finishes, then apply/commit manually.

## Inspect And Resume

```powershell
node .\bridge.mjs orchestrate status
node .\bridge.mjs orchestrate status --raw
node .\bridge.mjs orchestrate resume
node .\bridge.mjs orchestrate resume --yes
```

Default output redacts task text using size and SHA-256 summaries. Use `--raw`
only when local task text is safe to print.

If `resume` returns `orchestrate-resume-blocked`, inspect the target workspace
before starting a fresh run or manually recording the result. The bridge will not
silently rerun a side-effecting worker turn.
