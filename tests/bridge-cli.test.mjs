import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBridge = path.join(repoRoot, "bridge.mjs");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-test-"));
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, "utf8");
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

function runBridge(dir, args) {
  const result = spawnSync(process.execPath, ["bridge.mjs", ...args], {
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

function ok(result) {
  assert.equal(result.status, 0, result.text);
  return JSON.parse(result.stdout);
}

function fails(result, pattern) {
  assert.notEqual(result.status, 0, result.text);
  assert.match(result.text, pattern);
}

test("duet lifecycle redacts by default and exposes text only with --raw", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_DUET_TEST_123";
  writeFile(dir, "goal.md", `Goal ${secret}`);
  writeFile(dir, "handoff.md", `Handoff ${secret}`);
  writeFile(dir, "note.md", `Note ${secret}`);

  const init = runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "4"]);
  assert.equal(init.status, 0, init.text);
  assert.doesNotMatch(init.text, new RegExp(secret));

  const pass = runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]);
  assert.equal(pass.status, 0, pass.text);
  assert.doesNotMatch(pass.text, new RegExp(secret));

  const note = runBridge(dir, ["duet", "note", "--agent", "minimax", "--note", "note.md"]);
  assert.equal(note.status, 0, note.text);
  assert.doesNotMatch(note.text, new RegExp(secret));

  const show = ok(runBridge(dir, ["duet", "show"]));
  assert.equal(show.state.status, "running");
  assert.equal(show.state.baton, "minimax");
  assert.equal(show.state.iteration, 2);
  assert.equal(show.raw, false);
  assert.doesNotMatch(JSON.stringify(show), new RegExp(secret));
  assert.equal(typeof show.state.goal.sha256, "string");
  assert.equal(typeof show.journal.sha256, "string");

  const rawShow = ok(runBridge(dir, ["duet", "show", "--raw"]));
  assert.equal(rawShow.raw, true);
  assert.match(JSON.stringify(rawShow), new RegExp(secret));
});

test("duet done state blocks further passes without --force", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Finishable goal");
  writeFile(dir, "handoff.md", "Finished handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "3"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "minimax", "--status", "done", "--handoff", "handoff.md"]));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "done");
  assert.equal(state.baton, null);

  fails(
    runBridge(dir, ["duet", "pass", "--from", "minimax", "--to", "codex", "--handoff", "handoff.md"]),
    /duet status is done/,
  );
});

test("maxIterations stops relay without incrementing past the limit", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Limit goal");
  writeFile(dir, "handoff.md", "Limit handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "1"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "human_escalation");
  assert.equal(state.iteration, 1);
  assert.equal(state.maxIterations, 1);
  assert.equal(state.baton, null);
  assert.equal(state.humanEscalation, "maxIterations reached (1)");
});

test("duet validates bad inputs and damaged runtime state", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Validation goal");
  writeFile(dir, "handoff.md", "Validation handoff");
  writeFile(dir, "too-large.md", "x".repeat(20001));

  fails(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "nope"]), /positive integer/);
  fails(runBridge(dir, ["duet", "init", "--goal", "too-large.md"]), /file is too large/);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "2"]));
  fails(runBridge(dir, ["duet", "init", "--goal", "goal.md"]), /already exists/);

  fs.writeFileSync(
    path.join(dir, "duet-state.json"),
    JSON.stringify({ goal: "x", baton: "codex", iteration: 1, status: "running", lastHandoff: "", humanEscalation: null }),
    "utf8",
  );
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /invalid duet state: maxIterations/);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "2", "--force"]));
  fs.rmSync(path.join(dir, "duet-journal.md"));
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /duet journal is missing/);
});

test("duet lock blocks overlapping mutating commands and stale lock is cleared", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Lock goal");
  writeFile(dir, "handoff.md", "Lock handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "3"]));
  const lockPath = path.join(dir, "duet.lock");
  fs.writeFileSync(lockPath, "held", "utf8");
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /duet lock is held/);

  const stale = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, stale, stale);
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));
  assert.equal(readJson(dir, "duet-state.json").baton, "minimax");
});

test("safe local commands work in an isolated runtime directory", (t) => {
  const dir = sandbox(t);

  assert.equal(runBridge(dir, ["help"]).status, 0);
  assert.equal(runBridge(dir, ["duet", "help"]).status, 0);
  assert.equal(ok(runBridge(dir, ["config", "show"])).event, "config");
  assert.equal(ok(runBridge(dir, ["mode", "list"])).event, "mode");
  assert.equal(ok(runBridge(dir, ["session", "show"])).event, "session");
  assert.equal(ok(runBridge(dir, ["deny-session", "list"])).event, "deny-session");
  assert.equal(ok(runBridge(dir, ["token-stats", "--ledger", "--lines", "5"])).event, "token-stats");
});

test("runtime files, duet temp files, and local scratch files are git-ignored", () => {
  const samples = [
    "ledger.jsonl",
    "outbox.jsonl",
    "duet-state.json",
    "duet-journal.md",
    "duet.lock",
    "duet-state.json.123.tmp",
    "duet-journal.md.123.tmp",
    "handoff.local.md",
  ];

  for (const sample of samples) {
    const result = spawnSync("git", ["check-ignore", "-v", sample], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${sample} is not ignored\n${result.stdout}${result.stderr}`);
  }
});

test("installable skill and prompt surfaces document duet relay", () => {
  const files = [
    "skills/bridge/SKILL.md",
    "skills/codex-bridge/SKILL.md",
    "prompts/bridge.md",
    "README.md",
    "docs/COMMANDS.md",
    "docs/DUET_RELAY.md",
    "docs/RUNTIME_FILES.md",
  ];

  for (const relative of files) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /duet|Duet/, `${relative} should mention Duet`);
  }
});
