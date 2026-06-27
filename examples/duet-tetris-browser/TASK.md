# Duet Browser Tetris Task

This is the acceptance contract for the minimal human request:

```text
Сделай тетрис, который запускается в браузере.
```

Use Mavis MiniMax Bridge Duet Relay to build a browser-playable Tetris game with
two agents.

Create these files:

- `examples/duet-tetris-browser/index.html`
- `examples/duet-tetris-browser/styles.css`
- `examples/duet-tetris-browser/game.js`

Constraints:

1. No build step and no external network dependencies.
2. The game must run by opening `index.html` in a browser.
3. Use a visible 10 x 20 Tetris board, a next-piece preview, score, lines,
   level, status text, and start/pause/reset controls.
4. Implement keyboard controls:
   - Left / Right: move piece.
   - Down: soft drop.
   - Up or X: rotate.
   - Space: hard drop.
   - P: pause/resume.
5. Implement all seven tetrominoes: `I`, `O`, `T`, `S`, `Z`, `J`, `L`.
6. Implement collision, piece locking, line clearing, scoring, leveling, game
   over, pause/resume, and reset.
7. Starting the browser game must start an automatic drop loop.
8. Expose this test hook from `game.js`:

```js
window.TetrisGame = {
  SHAPES,
  createGame
};
```

`createGame(options)` must return an object with:

```js
{
  start,
  pause,
  resume,
  reset,
  tick,
  moveLeft,
  moveRight,
  softDrop,
  hardDrop,
  rotate,
  getState
}
```

The verifier calls `createGame` with fake canvases and a deterministic
`random()` function. For deterministic acceptance tests, `createGame(options)`
must also accept:

```js
{
  initialBoard,
  initialLines,
  pieceQueue
}
```

- `initialBoard`: optional 20 x 10 board to clone into the game.
- `initialLines`: optional starting line count for level-progression tests.
- `pieceQueue`: optional array of tetromino names consumed before random
  pieces.

`getState()` must return a plain object with:

```js
{
  board,
  currentPiece,
  nextPiece,
  score,
  lines,
  level,
  paused,
  gameOver
}
```

Acceptance:

```powershell
node .\examples\duet-tetris-browser\verify.mjs
```

For intermediate implementation-only checks before the relay is marked `done`:

```powershell
node .\examples\duet-tetris-browser\verify.mjs --skip-relay-check
```

The final run must pass without `--skip-relay-check`.
