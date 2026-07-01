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

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-orch-test-"));
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  fs.cpSync(sourceLib, path.join(dir, "lib"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runBridge(dir, args) {
  const result = spawnSync(process.execPath, [path.join(dir, "bridge.mjs"), ...args], {
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

function okJson(result) {
  assert.equal(result.status, 0, result.text);
  return JSON.parse(result.stdout);
}

function appendLine(filePath, value) {
  fs.appendFileSync(filePath, `${typeof value === "string" ? value : JSON.stringify(value)}\n`, "utf8");
}

test("orchestrate status reports empty local state without creating runtime files", (t) => {
  const dir = sandbox(t);
  const out = okJson(runBridge(dir, ["orchestrate", "status"]));

  assert.equal(out.event, "orchestrate-status");
  assert.equal(out.hasTask, false);
  assert.equal(out.state.status, "none");
  assert.equal(out.state.step, 0);
  assert.equal(out.ledger.events, 0);
  assert.equal(out.ledger.dropped, 0);
  assert.deepEqual(out.warnings, []);
  assert.equal(fs.existsSync(path.join(dir, "orch-ledger.jsonl")), false);
  assert.equal(fs.existsSync(path.join(dir, "ledger.jsonl")), false);
});

test("orchestrate status projects ledger state and warns about malformed lines", (t) => {
  const dir = sandbox(t);
  const ledgerPath = path.join(dir, "orch-ledger.jsonl");
  appendLine(ledgerPath, { kind: "init", step: 0 });
  appendLine(ledgerPath, "{not-json");
  appendLine(ledgerPath, {
    kind: "decision",
    step: 2,
    usage: { inputTokens: 7, outputTokens: 5 },
    decision: { action: "run", worker: "claude", subtask: "Inspect the orchestrator command surface" },
  });

  const out = okJson(runBridge(dir, ["orchestrate", "status", "--raw"]));

  assert.equal(out.hasTask, true);
  assert.equal(out.state.status, "running");
  assert.equal(out.state.step, 2);
  assert.equal(out.state.spent.tokens, 12);
  assert.equal(out.state.lastDecision.subtask, "Inspect the orchestrator command surface");
  assert.equal(out.ledger.events, 2);
  assert.equal(out.ledger.dropped, 1);
  assert.match(out.warnings.join("\n"), /malformed orch-ledger/);
});

test("orchestrate status redacts decision text by default", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_ORCH_DECISION_TEXT";
  appendLine(path.join(dir, "orch-ledger.jsonl"), {
    kind: "decision",
    step: 1,
    decision: {
      action: "run",
      worker: "codex",
      subtask: `Analyze ${secret}`,
      reason: `Because ${secret}`,
    },
  });

  const result = runBridge(dir, ["orchestrate", "status"]);
  const out = okJson(result);

  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.equal(out.state.lastDecision.subtask.chars, `Analyze ${secret}`.length);
  assert.equal(out.state.lastDecision.reason.chars, `Because ${secret}`.length);
  assert.match(out.state.lastDecision.subtask.sha256, /^[a-f0-9]{64}$/);
});

test("orchestrate status reports ambiguous side-effecting tail", (t) => {
  const dir = sandbox(t);
  appendLine(path.join(dir, "orch-ledger.jsonl"), {
    kind: "worker-started",
    step: 3,
    worker: "minimax",
    subtask: "Apply patch to target workspace",
  });

  const out = okJson(runBridge(dir, ["orchestrate", "status"]));

  assert.equal(out.ambiguousTail.worker, "minimax");
  assert.equal(out.ambiguousTail.subtask.chars, "Apply patch to target workspace".length);
  assert.match(out.warnings.join("\n"), /no recorded result/);
});
