# Duet Browser Tetris Test

This is a larger live smoke for Duet Relay:

```text
examples/duet-tetris-browser/
```

The agents must jointly create a browser-playable Tetris implementation. The
verifier checks more than file existence: it loads `game.js` in a mocked browser
runtime, creates a deterministic game instance, exercises movement, rotation,
drop, pause/resume, hard drop, reset, and confirms the relay is `done`.

There are two useful ways to run it:

- **Minimal human start:** the human only asks for Tetris and the agents must
  discover the local task, plan, roles, and checks themselves.
- **Directed acceptance start:** the prompt points directly at
  `examples/duet-tetris-browser/TASK.md`.

## Reset

From the repository root:

```powershell
Remove-Item .\duet-state.json, .\duet-journal.md, .\duet.lock -ErrorAction SilentlyContinue
Remove-Item .\examples\duet-tetris-browser\index.html -ErrorAction SilentlyContinue
Remove-Item .\examples\duet-tetris-browser\styles.css -ErrorAction SilentlyContinue
Remove-Item .\examples\duet-tetris-browser\game.js -ErrorAction SilentlyContinue
```

## Minimal Start

Paste this into either agent:

```text
Сделай тетрис, который запускается в браузере.

Используй Mavis MiniMax Bridge Duet Relay.
Сами договоритесь о плане, ролях, порядке работы и проверках.
Передайте ход другому агенту хотя бы один раз.
Вернитесь ко мне только когда задача готова или нужен настоящий человеческий
выбор.

let's go
```

When the first agent passes the baton, open the other agent surface and ask:

```text
Продолжи текущий Mavis MiniMax Bridge Duet Relay.
Самостоятельно прочитай состояние, журнал, найденные файлы задачи и проверки.
Действуй как второй агент: проверь, дополни или исправь работу первого агента,
а завершай только если результат действительно готов.

let's go
```

This mode intentionally does not assign implementation roles. The agents should
inspect the repository, find `examples/duet-tetris-browser`, use the verifier,
and decide how to split planning, implementation, review, and finalization.

## Directed Start

Paste this into either agent:

```text
Task:
Build the browser Tetris game described in examples/duet-tetris-browser/TASK.md.

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
Read the relay state and journal, complete or review the Tetris implementation
in examples/duet-tetris-browser, run the verifier, and finish only if the final
acceptance check passes.

let's go
```

## Verify

Intermediate implementation-only verification:

```powershell
node .\examples\duet-tetris-browser\verify.mjs --skip-relay-check
```

Final verification:

```powershell
node .\examples\duet-tetris-browser\verify.mjs
```

Expected output:

```text
PASS duet-tetris-browser
```

## Browser Check

Open this file in a browser:

```text
examples/duet-tetris-browser/index.html
```

The first screen should be the game itself: board, next-piece preview, score,
lines, level, status, and controls. The game should respond to keyboard input.
