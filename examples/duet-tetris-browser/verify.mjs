import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "../..");
const skipRelayCheck = process.argv.includes("--skip-relay-check");

function read(fileName) {
  return fs.readFileSync(path.join(taskDir, fileName), "utf8");
}

function assertRequiredFiles() {
  for (const fileName of ["index.html", "styles.css", "game.js"]) {
    const filePath = path.join(taskDir, fileName);
    assert.equal(fs.existsSync(filePath), true, `${fileName} must exist`);
    assert.ok(fs.statSync(filePath).size > 200, `${fileName} must not be a stub`);
  }
}

function assertStaticSurface() {
  const html = read("index.html");
  const css = read("styles.css");
  const js = read("game.js");

  assert.match(html, /<canvas[^>]+id=["']board["']/i, "index.html must contain canvas#board");
  assert.match(html, /<canvas[^>]+id=["']next["']/i, "index.html must contain canvas#next");
  assert.match(html, /id=["']score["']/i, "index.html must contain #score");
  assert.match(html, /id=["']lines["']/i, "index.html must contain #lines");
  assert.match(html, /id=["']level["']/i, "index.html must contain #level");
  assert.match(html, /id=["']start["']/i, "index.html must contain #start control");
  assert.match(html, /id=["']pause["']/i, "index.html must contain #pause control");
  assert.match(html, /id=["']reset["']/i, "index.html must contain #reset control");
  assert.match(html, /styles\.css/i, "index.html must reference styles.css");
  assert.match(html, /game\.js/i, "index.html must reference game.js");
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /https?:\/\//i, "task must not depend on external network assets");
  assert.doesNotMatch(js, /\beval\s*\(|new\s+Function\s*\(/, "game.js must not use eval-like execution");
  assert.match(js, /TetrisGame/, "game.js must expose window.TetrisGame");
  assert.match(css, /canvas|grid|board/i, "styles.css must include visible game styling");
}

function createCanvas(id) {
  const calls = [];
  return {
    id,
    width: id === "board" ? 300 : 120,
    height: id === "board" ? 600 : 120,
    calls,
    getContext(type) {
      assert.equal(type, "2d", `${id} canvas should request 2d context`);
      return {
        calls,
        fillStyle: "#000",
        strokeStyle: "#000",
        lineWidth: 1,
        clearRect: (...args) => calls.push(["clearRect", ...args]),
        fillRect: (...args) => calls.push(["fillRect", ...args]),
        strokeRect: (...args) => calls.push(["strokeRect", ...args]),
        fillText: (...args) => calls.push(["fillText", ...args]),
        beginPath: () => calls.push(["beginPath"]),
        moveTo: (...args) => calls.push(["moveTo", ...args]),
        lineTo: (...args) => calls.push(["lineTo", ...args]),
        stroke: () => calls.push(["stroke"]),
      };
    },
  };
}

function createDom() {
  const boardCanvas = createCanvas("board");
  const nextCanvas = createCanvas("next");
  const listeners = {};

  function button(id) {
    return {
      id,
      addEventListener(type, handler) {
        listeners[`${id}:${type}`] = handler;
      },
    };
  }

  const elements = new Map([
    ["board", boardCanvas],
    ["next", nextCanvas],
    ["score", { id: "score", textContent: "" }],
    ["lines", { id: "lines", textContent: "" }],
    ["level", { id: "level", textContent: "" }],
    ["status", { id: "status", textContent: "" }],
    ["start", button("start")],
    ["pause", button("pause")],
    ["reset", button("reset")],
  ]);

  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      return selector.startsWith("#") ? elements.get(selector.slice(1)) || null : null;
    },
    addEventListener(type, handler) {
      listeners[`document:${type}`] = handler;
    },
  };

  const window = {
    document,
    intervalCalls: [],
    addEventListener(type, handler) {
      listeners[`window:${type}`] = handler;
    },
    removeEventListener() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
    setInterval(handler, delay) {
      this.intervalCalls.push({ handler, delay });
      return this.intervalCalls.length;
    },
    clearInterval() {},
  };
  window.window = window;
  window.globalThis = window;

  return { window, document, elements, listeners };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function settledCellCount(board) {
  return board.flat().filter(Boolean).length;
}

function filledBoardWithGap(gapStart, gapWidth) {
  const board = Array.from({ length: 20 }, () => Array(10).fill(0));
  board[19] = Array.from({ length: 10 }, (_, index) => (index >= gapStart && index < gapStart + gapWidth ? 0 : "Z"));
  return board;
}

function blankBoardWithSpawnCollision() {
  const board = Array.from({ length: 20 }, () => Array(10).fill(0));
  board[0][4] = "Z";
  board[0][5] = "Z";
  return board;
}

function keyboardEvent(key, code = key) {
  return {
    key,
    code,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function invoke(listener, event = {}) {
  assert.equal(typeof listener, "function", "expected DOM event listener");
  return listener(event);
}

function assertRuntimeBehavior() {
  const dom = createDom();
  const context = vm.createContext({
    window: dom.window,
    document: dom.document,
    console,
    requestAnimationFrame: dom.window.requestAnimationFrame,
    cancelAnimationFrame: dom.window.cancelAnimationFrame,
    setInterval: dom.window.setInterval.bind(dom.window),
    clearInterval: dom.window.clearInterval.bind(dom.window),
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(read("game.js"), context, { filename: "game.js", timeout: 1000 });

  const exported = context.window.TetrisGame;
  assert.ok(exported, "window.TetrisGame must be defined");
  assert.equal(typeof exported.createGame, "function", "TetrisGame.createGame must be a function");

  const shapeNames = Object.keys(exported.SHAPES || {}).sort();
  assert.deepEqual(shapeNames, ["I", "J", "L", "O", "S", "T", "Z"].sort(), "all seven tetrominoes must be exposed");

  assert.equal(typeof dom.listeners["window:DOMContentLoaded"], "function", "browser boot must register DOMContentLoaded");
  invoke(dom.listeners["window:DOMContentLoaded"]);
  for (const listenerName of ["start:click", "pause:click", "reset:click", "document:keydown"]) {
    assert.equal(typeof dom.listeners[listenerName], "function", `browser boot must register ${listenerName}`);
  }

  invoke(dom.listeners["start:click"]);
  assert.match(String(dom.elements.get("status").textContent), /playing/i, "start button must start the browser game");
  assert.ok(dom.window.intervalCalls.length > 0, "browser start must start an automatic drop loop");
  assert.ok(dom.window.intervalCalls.some((call) => call.delay > 0 && call.delay <= 1000), "drop loop delay must be playable");
  assert.ok(dom.elements.get("board").calls.some((call) => call[0] === "fillRect"), "browser start must draw to board canvas");
  assert.ok(dom.elements.get("next").calls.some((call) => call[0] === "fillRect"), "browser start must draw next piece");
  const callsBeforeKeyboard = dom.elements.get("board").calls.length;
  invoke(dom.listeners["document:keydown"], keyboardEvent("ArrowLeft"));
  invoke(dom.listeners["document:keydown"], keyboardEvent("ArrowRight"));
  invoke(dom.listeners["document:keydown"], keyboardEvent("ArrowDown"));
  invoke(dom.listeners["document:keydown"], keyboardEvent("ArrowUp"));
  invoke(dom.listeners["document:keydown"], keyboardEvent("x", "KeyX"));
  invoke(dom.listeners["document:keydown"], keyboardEvent(" ", "Space"));
  invoke(dom.listeners["document:keydown"], keyboardEvent("p", "KeyP"));
  assert.ok(dom.elements.get("board").calls.length > callsBeforeKeyboard, "keyboard controls must affect the rendered game");
  invoke(dom.listeners["pause:click"]);
  assert.match(String(dom.elements.get("status").textContent), /paused|playing/i, "pause button must toggle status");
  invoke(dom.listeners["reset:click"]);
  assert.equal(String(dom.elements.get("score").textContent), "0", "reset button must clear score in the browser UI");

  const randomValues = [0.35, 0.05, 0.15, 0.45, 0.65, 0.85];
  let randomIndex = 0;
  const game = exported.createGame({
    boardCanvas: dom.elements.get("board"),
    nextCanvas: dom.elements.get("next"),
    random: () => randomValues[randomIndex++ % randomValues.length],
  });

  for (const method of ["start", "pause", "resume", "reset", "tick", "moveLeft", "moveRight", "softDrop", "hardDrop", "rotate", "getState"]) {
    assert.equal(typeof game[method], "function", `game.${method} must be a function`);
  }

  game.start();
  let state = game.getState();
  assert.equal(state.board.length, 20, "board must have 20 rows");
  assert.ok(state.board.every((row) => Array.isArray(row) && row.length === 10), "board must have 10 columns");
  assert.ok(state.currentPiece, "start() must create a current piece");
  assert.ok(state.nextPiece, "start() must create a next piece");
  assert.equal(typeof state.score, "number");
  assert.equal(typeof state.lines, "number");
  assert.equal(typeof state.level, "number");

  const beforeMove = clone(state.currentPiece);
  game.moveLeft();
  state = game.getState();
  assert.ok(state.currentPiece.x <= beforeMove.x, "moveLeft() must move or respect collision");
  game.moveRight();
  state = game.getState();
  assert.ok(state.currentPiece.x >= beforeMove.x - 1, "moveRight() must move or respect collision");

  const beforeRotate = JSON.stringify(state.currentPiece.matrix);
  game.rotate();
  state = game.getState();
  assert.notEqual(JSON.stringify(state.currentPiece.matrix), beforeRotate, "rotate() must rotate a non-square deterministic first piece");

  const beforeSoftDropY = state.currentPiece.y;
  game.softDrop();
  state = game.getState();
  assert.ok(state.currentPiece.y >= beforeSoftDropY, "softDrop() must move downward or lock");

  game.pause();
  state = game.getState();
  assert.equal(state.paused, true, "pause() must set paused state");
  const pausedSnapshot = JSON.stringify(state);
  game.tick();
  assert.equal(JSON.stringify(game.getState()), pausedSnapshot, "tick() must not mutate state while paused");

  game.resume();
  assert.equal(game.getState().paused, false, "resume() must clear paused state");
  game.hardDrop();
  state = game.getState();
  assert.ok(settledCellCount(state.board) > 0, "hardDrop() must lock a piece into the board");

  game.reset();
  state = game.getState();
  assert.equal(settledCellCount(state.board), 0, "reset() must clear the board");
  assert.equal(state.score, 0, "reset() must clear score");
  assert.equal(state.lines, 0, "reset() must clear lines");
  assert.equal(state.gameOver, false, "reset() must clear game over");

  const lineClearGame = exported.createGame({
    boardCanvas: createCanvas("line-clear-board"),
    nextCanvas: createCanvas("line-clear-next"),
    initialBoard: filledBoardWithGap(3, 4),
    initialLines: 9,
    pieceQueue: ["I", "O"],
  });
  lineClearGame.start();
  lineClearGame.hardDrop();
  const clearedState = lineClearGame.getState();
  assert.equal(clearedState.lines, 10, "hardDrop() must clear a completed line");
  assert.equal(clearedState.level, 2, "line clearing must advance level after 10 lines");
  assert.ok(clearedState.score >= 100, "line clearing must increase score by Tetris scoring rules");
  assert.equal(clearedState.board[19].every(Boolean), false, "cleared line must be removed from the board");

  const gameOverGame = exported.createGame({
    boardCanvas: createCanvas("game-over-board"),
    nextCanvas: createCanvas("game-over-next"),
    initialBoard: blankBoardWithSpawnCollision(),
    pieceQueue: ["O"],
  });
  gameOverGame.start();
  assert.equal(gameOverGame.getState().gameOver, true, "spawn collision must set gameOver");
}

function verifyRelay() {
  const statePath = path.join(repoRoot, "duet-state.json");
  const journalPath = path.join(repoRoot, "duet-journal.md");

  assert.equal(fs.existsSync(statePath), true, "duet-state.json must exist");
  assert.equal(fs.existsSync(journalPath), true, "duet-journal.md must exist");

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const journal = fs.readFileSync(journalPath, "utf8");

  assert.equal(state.status, "done", "duet status must be done");
  assert.equal(state.baton, null, "done relay must not keep a baton holder");
  assert.ok(state.iteration >= 2, "relay must include at least one baton pass");
  assert.match(`${JSON.stringify(state)}\n${journal}`, /tetris|тетри/i, "relay must be tied to the Tetris task");
  assert.match(journal, /codex/i, "journal must mention Codex contribution");
  assert.match(journal, /minimax/i, "journal must mention MiniMax contribution");
}

assertRequiredFiles();
assertStaticSurface();
assertRuntimeBehavior();

if (!skipRelayCheck) {
  verifyRelay();
}

console.log("PASS duet-tetris-browser");
