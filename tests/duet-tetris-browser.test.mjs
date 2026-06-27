import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBridge = path.join(repoRoot, "bridge.mjs");
const sourceLib = path.join(repoRoot, "lib");
const sourceTask = path.join(repoRoot, "examples", "duet-tetris-browser");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-tetris-"));
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  if (fs.existsSync(sourceLib)) {
    fs.cpSync(sourceLib, path.join(dir, "lib"), { recursive: true });
  }
  fs.cpSync(sourceTask, path.join(dir, "examples", "duet-tetris-browser"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, name, text) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function runNode(dir, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    text: `${result.stdout}${result.stderr}`,
  };
}

function runBridge(dir, args) {
  return runNode(dir, ["bridge.mjs", ...args]);
}

function ok(result) {
  assert.equal(result.status, 0, result.text);
  return JSON.parse(result.stdout);
}

function writeCodexScaffold(dir) {
  writeFile(
    dir,
    "examples/duet-tetris-browser/index.html",
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Duet Tetris</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="game-shell">
    <section class="board-wrap">
      <canvas id="board" width="300" height="600" aria-label="Tetris board"></canvas>
    </section>
    <aside class="panel">
      <h1>Duet Tetris</h1>
      <canvas id="next" width="120" height="120" aria-label="Next piece"></canvas>
      <dl>
        <dt>Score</dt><dd id="score">0</dd>
        <dt>Lines</dt><dd id="lines">0</dd>
        <dt>Level</dt><dd id="level">1</dd>
      </dl>
      <p id="status">Ready</p>
      <div class="controls">
        <button id="start" type="button">Start</button>
        <button id="pause" type="button">Pause</button>
        <button id="reset" type="button">Reset</button>
      </div>
    </aside>
  </main>
  <script src="game.js"></script>
</body>
</html>
`,
  );

  writeFile(
    dir,
    "examples/duet-tetris-browser/styles.css",
    `:root {
  color-scheme: dark;
  font-family: Inter, Segoe UI, system-ui, sans-serif;
  background: #15181f;
  color: #f6f7fb;
}

* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
.game-shell {
  width: min(920px, 96vw);
  display: grid;
  grid-template-columns: minmax(260px, 360px) minmax(180px, 260px);
  gap: 24px;
  align-items: start;
}
.board-wrap { display: grid; place-items: center; }
canvas {
  background: #090b10;
  border: 2px solid #394150;
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
#board { width: min(72vw, 360px); aspect-ratio: 1 / 2; height: auto; }
#next { width: 120px; height: 120px; margin-block: 12px 18px; }
.panel { display: grid; gap: 14px; }
h1 { margin: 0; font-size: 28px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; }
dt { color: #aeb7c8; }
dd { margin: 0; font-variant-numeric: tabular-nums; }
#status { min-height: 24px; margin: 0; color: #8ee8b0; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; }
button { min-height: 36px; padding: 0 14px; border: 0; background: #d7ff63; color: #111; font-weight: 700; cursor: pointer; }
@media (max-width: 680px) {
  .game-shell { grid-template-columns: 1fr; justify-items: center; }
  .panel { width: min(360px, 94vw); }
}
`,
  );
}

function writeMiniMaxGame(dir) {
  writeFile(
    dir,
    "examples/duet-tetris-browser/game.js",
    `(function () {
  "use strict";

  const COLS = 10;
  const ROWS = 20;
  const CELL = 30;
  const TYPES = ["I", "O", "T", "S", "Z", "J", "L"];
  const COLORS = {
    I: "#54d9ff",
    O: "#f5dc4b",
    T: "#c77dff",
    S: "#7bd88f",
    Z: "#ff6b6b",
    J: "#63a4ff",
    L: "#ffa94d",
  };
  const SHAPES = {
    I: [[1, 1, 1, 1]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1]],
    S: [[0, 1, 1], [1, 1, 0]],
    Z: [[1, 1, 0], [0, 1, 1]],
    J: [[1, 0, 0], [1, 1, 1]],
    L: [[0, 0, 1], [1, 1, 1]],
  };

  function cloneMatrix(matrix) {
    return matrix.map((row) => row.slice());
  }

  function emptyBoard() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  }

  function rotateMatrix(matrix) {
    return matrix[0].map((_, x) => matrix.map((row) => row[x]).reverse());
  }

  function createGame(options = {}) {
    const boardCanvas = options.boardCanvas || document.getElementById("board");
    const nextCanvas = options.nextCanvas || document.getElementById("next");
    const random = options.random || Math.random;
    const pieceQueue = Array.isArray(options.pieceQueue) ? options.pieceQueue.slice() : [];
    const boardCtx = boardCanvas && boardCanvas.getContext ? boardCanvas.getContext("2d") : null;
    const nextCtx = nextCanvas && nextCanvas.getContext ? nextCanvas.getContext("2d") : null;
    const scoreEl = document.getElementById("score");
    const linesEl = document.getElementById("lines");
    const levelEl = document.getElementById("level");
    const statusEl = document.getElementById("status");

    let board = Array.isArray(options.initialBoard) ? cloneMatrix(options.initialBoard) : emptyBoard();
    let currentPiece = null;
    let nextPiece = randomPiece();
    let score = 0;
    let lines = Number(options.initialLines || 0);
    let level = Math.floor(lines / 10) + 1;
    let paused = false;
    let gameOver = false;
    let started = false;

    function randomPiece() {
      const queued = pieceQueue.shift();
      const type = queued && SHAPES[queued] ? queued : TYPES[Math.floor(random() * TYPES.length) % TYPES.length];
      return { type, matrix: cloneMatrix(SHAPES[type]), x: 3, y: 0 };
    }

    function spawn() {
      currentPiece = nextPiece || randomPiece();
      currentPiece.x = Math.floor((COLS - currentPiece.matrix[0].length) / 2);
      currentPiece.y = 0;
      nextPiece = randomPiece();
      if (collides(currentPiece.x, currentPiece.y, currentPiece.matrix)) {
        gameOver = true;
        started = false;
        setStatus("Game over");
      }
    }

    function collides(x, y, matrix) {
      for (let row = 0; row < matrix.length; row += 1) {
        for (let col = 0; col < matrix[row].length; col += 1) {
          if (!matrix[row][col]) continue;
          const bx = x + col;
          const by = y + row;
          if (bx < 0 || bx >= COLS || by >= ROWS) return true;
          if (by >= 0 && board[by][bx]) return true;
        }
      }
      return false;
    }

    function merge() {
      for (let row = 0; row < currentPiece.matrix.length; row += 1) {
        for (let col = 0; col < currentPiece.matrix[row].length; col += 1) {
          if (currentPiece.matrix[row][col]) {
            const by = currentPiece.y + row;
            const bx = currentPiece.x + col;
            if (by >= 0) board[by][bx] = currentPiece.type;
          }
        }
      }
    }

    function clearLines() {
      let cleared = 0;
      board = board.filter((row) => {
        if (row.every(Boolean)) {
          cleared += 1;
          return false;
        }
        return true;
      });
      while (board.length < ROWS) board.unshift(Array(COLS).fill(0));
      if (cleared) {
        lines += cleared;
        score += [0, 100, 300, 500, 800][cleared] * level;
        level = Math.floor(lines / 10) + 1;
      }
    }

    function lockPiece() {
      merge();
      clearLines();
      spawn();
    }

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    function updateHud() {
      if (scoreEl) scoreEl.textContent = String(score);
      if (linesEl) linesEl.textContent = String(lines);
      if (levelEl) levelEl.textContent = String(level);
    }

    function drawCell(ctx, x, y, type, size = CELL) {
      if (!ctx) return;
      ctx.fillStyle = COLORS[type] || "#d7ff63";
      ctx.fillRect(x * size, y * size, size, size);
      ctx.strokeStyle = "#111821";
      ctx.strokeRect(x * size, y * size, size, size);
    }

    function renderBoard() {
      if (!boardCtx) return;
      boardCtx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
      board.forEach((row, y) => row.forEach((type, x) => type && drawCell(boardCtx, x, y, type)));
      if (currentPiece) {
        currentPiece.matrix.forEach((row, y) => row.forEach((filled, x) => {
          if (filled) drawCell(boardCtx, currentPiece.x + x, currentPiece.y + y, currentPiece.type);
        }));
      }
    }

    function renderNext() {
      if (!nextCtx || !nextPiece) return;
      nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
      nextPiece.matrix.forEach((row, y) => row.forEach((filled, x) => {
        if (filled) drawCell(nextCtx, x + 1, y + 1, nextPiece.type, 24);
      }));
    }

    function render() {
      updateHud();
      renderBoard();
      renderNext();
    }

    function start() {
      gameOver = false;
      if (!currentPiece) spawn();
      started = !gameOver;
      paused = false;
      setStatus(gameOver ? "Game over" : "Playing");
      render();
    }

    function pause() {
      if (!started || gameOver) return;
      paused = true;
      setStatus("Paused");
      render();
    }

    function resume() {
      if (!started || gameOver) return;
      paused = false;
      setStatus("Playing");
      render();
    }

    function reset() {
      board = Array.isArray(options.initialBoard) ? cloneMatrix(options.initialBoard) : emptyBoard();
      score = 0;
      lines = Number(options.initialLines || 0);
      level = Math.floor(lines / 10) + 1;
      paused = false;
      gameOver = false;
      started = false;
      currentPiece = null;
      nextPiece = randomPiece();
      setStatus("Ready");
      render();
    }

    function tick() {
      if (!started || paused || gameOver) return false;
      if (!collides(currentPiece.x, currentPiece.y + 1, currentPiece.matrix)) {
        currentPiece.y += 1;
      } else {
        lockPiece();
      }
      render();
      return true;
    }

    function moveLeft() {
      if (started && !paused && !gameOver && !collides(currentPiece.x - 1, currentPiece.y, currentPiece.matrix)) {
        currentPiece.x -= 1;
        render();
      }
    }

    function moveRight() {
      if (started && !paused && !gameOver && !collides(currentPiece.x + 1, currentPiece.y, currentPiece.matrix)) {
        currentPiece.x += 1;
        render();
      }
    }

    function softDrop() {
      if (tick()) score += 1;
      updateHud();
    }

    function hardDrop() {
      if (!started || paused || gameOver) return;
      let distance = 0;
      while (!collides(currentPiece.x, currentPiece.y + 1, currentPiece.matrix)) {
        currentPiece.y += 1;
        distance += 1;
      }
      score += distance * 2;
      lockPiece();
      render();
    }

    function rotate() {
      if (!started || paused || gameOver) return;
      const rotated = rotateMatrix(currentPiece.matrix);
      for (const kick of [0, -1, 1, -2, 2]) {
        if (!collides(currentPiece.x + kick, currentPiece.y, rotated)) {
          currentPiece.x += kick;
          currentPiece.matrix = rotated;
          render();
          return;
        }
      }
    }

    function getState() {
      return {
        board: cloneMatrix(board),
        currentPiece: currentPiece ? { ...currentPiece, matrix: cloneMatrix(currentPiece.matrix) } : null,
        nextPiece: nextPiece ? { ...nextPiece, matrix: cloneMatrix(nextPiece.matrix) } : null,
        score,
        lines,
        level,
        paused,
        gameOver,
      };
    }

    return { start, pause, resume, reset, tick, moveLeft, moveRight, softDrop, hardDrop, rotate, getState };
  }

  window.TetrisGame = { SHAPES, createGame };

  window.addEventListener("DOMContentLoaded", () => {
    const game = createGame();
    let loopID = null;
    const loopDelay = () => Math.max(120, 800 - (game.getState().level - 1) * 55);
    const ensureLoop = () => {
      if (loopID || typeof window.setInterval !== "function") return;
      loopID = window.setInterval(() => {
        if (!game.getState().gameOver) game.tick();
      }, loopDelay());
    };

    document.getElementById("start").addEventListener("click", () => {
      game.start();
      ensureLoop();
    });
    document.getElementById("pause").addEventListener("click", () => (game.getState().paused ? game.resume() : game.pause()));
    document.getElementById("reset").addEventListener("click", () => {
      game.reset();
      ensureLoop();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") game.moveLeft();
      if (event.key === "ArrowRight") game.moveRight();
      if (event.key === "ArrowDown") game.softDrop();
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "x") game.rotate();
      if (event.code === "Space") game.hardDrop();
      if (event.key.toLowerCase() === "p") {
        if (game.getState().paused) game.resume();
        else game.pause();
      }
    });
    game.reset();
  });
}());
`,
  );
}

test("duet browser tetris acceptance scenario can be completed by two fake agents", (t) => {
  const dir = sandbox(t);

  writeFile(
    dir,
    "duet-goal.local.md",
    "Build examples/duet-tetris-browser/TASK.md with two agents and pass browser Tetris verification.",
  );
  writeFile(dir, "codex-note.local.md", "Codex created the browser HTML/CSS scaffold for the Tetris task.");
  writeFile(dir, "codex-handoff.local.md", "Codex scaffolded index.html and styles.css. MiniMax should implement game.js and run the verifier.");
  writeFile(dir, "minimax-note.local.md", "MiniMax implemented the Tetris runtime API and verified movement, rotation, drop, pause, reset, and relay completion.");
  writeFile(dir, "minimax-handoff.local.md", "MiniMax completed the browser Tetris implementation; final verifier passes.");

  ok(runBridge(dir, ["duet", "init", "--goal", "duet-goal.local.md", "--baton", "codex", "--max-iterations", "4"]));
  writeCodexScaffold(dir);
  ok(runBridge(dir, ["duet", "note", "--agent", "codex", "--note", "codex-note.local.md"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "codex-handoff.local.md"]));

  writeMiniMaxGame(dir);

  const implementationOnly = runNode(dir, ["examples/duet-tetris-browser/verify.mjs", "--skip-relay-check"]);
  assert.equal(implementationOnly.status, 0, implementationOnly.text);
  assert.match(implementationOnly.stdout, /PASS duet-tetris-browser/);

  ok(runBridge(dir, ["duet", "note", "--agent", "minimax", "--note", "minimax-note.local.md"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "minimax", "--status", "done", "--handoff", "minimax-handoff.local.md"]));

  const finalVerify = runNode(dir, ["examples/duet-tetris-browser/verify.mjs"]);
  assert.equal(finalVerify.status, 0, finalVerify.text);
  assert.match(finalVerify.stdout, /PASS duet-tetris-browser/);
});

test("duet browser tetris docs include a minimal human start", () => {
  const docs = fs.readFileSync(path.join(repoRoot, "docs", "DUET_TETRIS_BROWSER_TEST.md"), "utf8");
  const goal = fs.readFileSync(path.join(repoRoot, "examples", "duet-tetris-browser", "MINIMAL_GOAL.md"), "utf8");

  assert.match(docs, /Сделай тетрис, который запускается в браузере/);
  assert.match(goal, /Сделай тетрис, который запускается в браузере/);
  assert.match(docs, /Сами договоритесь о плане, ролях, порядке работы и проверках/);
  assert.match(docs, /intentionally does not assign implementation roles/);
});
