import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBridge = path.join(repoRoot, "bridge.mjs");
const sourceLib = path.join(repoRoot, "lib");
const sourceTask = path.join(repoRoot, "examples", "duet-simple-orders");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-acceptance-"));
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  if (fs.existsSync(sourceLib)) {
    fs.cpSync(sourceLib, path.join(dir, "lib"), { recursive: true });
  }
  fs.cpSync(sourceTask, path.join(dir, "examples", "duet-simple-orders"), { recursive: true });
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

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function checksum(answerWithoutChecksum) {
  return crypto.createHash("sha256").update(canonicalJson(answerWithoutChecksum)).digest("hex");
}

function expectedAnswerWithoutChecksum() {
  return {
    uniqueOrderCount: 5,
    duplicateOrderIds: ["A100"],
    totalAmount: 650,
    totalsByCurrency: {
      USD: { count: 3, totalAmount: 400 },
      EUR: { count: 2, totalAmount: 250 },
    },
    topCustomer: { customer: "Boris", totalAmount: 299.99, orderCount: 2 },
    orderIds: ["A100", "A101", "A102", "A103", "A104"],
  };
}

function writeCodexDraft(dir) {
  writeFile(
    dir,
    "examples/duet-simple-orders/codex-draft.local.json",
    `${JSON.stringify({ agent: "codex", answerWithoutChecksum: expectedAnswerWithoutChecksum() }, null, 2)}\n`,
  );
}

function assertCodexDraft(dir) {
  const draftPath = path.join(dir, "examples", "duet-simple-orders", "codex-draft.local.json");
  assert.equal(fs.existsSync(draftPath), true, "fake MiniMax must receive fake Codex draft");

  const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  assert.equal(draft.agent, "codex");
  assert.deepEqual(draft.answerWithoutChecksum, expectedAnswerWithoutChecksum());
}

function writeExpectedAnswer(dir) {
  const answerWithoutChecksum = {
    ...expectedAnswerWithoutChecksum(),
  };

  writeFile(
    dir,
    "examples/duet-simple-orders/answer.json",
    `${JSON.stringify({ ...answerWithoutChecksum, checksum: checksum(answerWithoutChecksum) }, null, 2)}\n`,
  );
}

test("duet simple orders acceptance scenario can be completed by two fake agents", (t) => {
  const dir = sandbox(t);

  writeFile(
    dir,
    "duet-goal.local.md",
    "Solve examples/duet-simple-orders/TASK.md with two agents and pass final verification.",
  );
  writeFile(dir, "codex-note.local.md", "Codex inspected TASK.md and input.json; MiniMax should produce answer.json and verify it.");
  writeFile(dir, "codex-handoff.local.md", "Codex parsed the task and passes implementation/verification to MiniMax.");
  writeFile(dir, "minimax-note.local.md", "MiniMax wrote answer.json, ran the verifier, and is ready to finish.");
  writeFile(dir, "minimax-handoff.local.md", "MiniMax completed the simple orders task; final verifier passes.");

  ok(runBridge(dir, ["duet", "init", "--goal", "duet-goal.local.md", "--baton", "codex", "--max-iterations", "4"]));
  writeCodexDraft(dir);
  ok(runBridge(dir, ["duet", "note", "--agent", "codex", "--note", "codex-note.local.md"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "codex-handoff.local.md"]));

  assertCodexDraft(dir);
  writeExpectedAnswer(dir);

  const answerOnly = runNode(dir, ["examples/duet-simple-orders/verify.mjs", "--skip-relay-check"]);
  assert.equal(answerOnly.status, 0, answerOnly.text);
  assert.match(answerOnly.stdout, /PASS duet-simple-orders/);

  ok(runBridge(dir, ["duet", "note", "--agent", "minimax", "--note", "minimax-note.local.md"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "minimax", "--status", "done", "--handoff", "minimax-handoff.local.md"]));

  const finalVerify = runNode(dir, ["examples/duet-simple-orders/verify.mjs"]);
  assert.equal(finalVerify.status, 0, finalVerify.text);
  assert.match(finalVerify.stdout, /PASS duet-simple-orders/);
});
