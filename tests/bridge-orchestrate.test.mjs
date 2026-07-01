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

function targetDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-orch-target-"));
  fs.writeFileSync(path.join(dir, "README.md"), "target\n", "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runBridge(dir, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(dir, "bridge.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
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

test("orchestrate start dry-run validates task and target without spending", (t) => {
  const dir = sandbox(t);
  const target = targetDir(t);
  fs.writeFileSync(path.join(dir, "TASK.md"), "Do the task.", "utf8");

  const out = okJson(runBridge(dir, ["orchestrate", "start", "--task", "TASK.md", "--target", target, "--dry-run"]));

  assert.equal(out.event, "orchestrate-start-dry-run");
  assert.equal(out.tokenSpending, false);
  assert.equal(out.target, target);
  assert.deepEqual(out.agents, ["codex", "minimax"]);
  assert.equal(fs.existsSync(path.join(dir, "orch-ledger.jsonl")), false);
});

test("orchestrate start runs a scripted fake loop to done", (t) => {
  const dir = sandbox(t);
  const target = targetDir(t);
  fs.writeFileSync(path.join(dir, "TASK.md"), "Create a tiny result.", "utf8");
  const replies = [
    '{"action":"run","worker":"codex","subtask":"write result"}',
    '{"did":"codex wrote result"}',
    '{"action":"done","summary":"finished"}',
  ];

  const out = okJson(runBridge(
    dir,
    ["orchestrate", "start", "--task", "TASK.md", "--target", target, "--yes", "--raw"],
    {
      env: {
        MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
        MAVIS_BRIDGE_TEST_MODEL_REPLIES: JSON.stringify(replies),
      },
    },
  ));

  const events = fs.readFileSync(path.join(dir, "orch-ledger.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(out.event, "orchestrate-start");
  assert.equal(out.result.status, "done");
  assert.deepEqual(events.map((event) => event.kind), ["init", "decision", "worker-started", "worker-result", "decision", "final"]);
  assert.equal(events.find((event) => event.kind === "worker-result").summary.did, "codex wrote result");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "orch-state.json"), "utf8")).status, "done");
});

test("orchestrate start rejects the bridge directory as target", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, "TASK.md"), "x", "utf8");

  const result = runBridge(dir, ["orchestrate", "start", "--task", "TASK.md", "--target", dir, "--yes"]);

  assert.notEqual(result.status, 0);
  assert.match(result.text, /target must not be the bridge repository/);
});

test("orchestrate resume surfaces interrupted worker-started without rerunning", (t) => {
  const dir = sandbox(t);
  const target = targetDir(t);
  appendLine(path.join(dir, "orch-ledger.jsonl"), {
    kind: "init",
    payload: {
      task: "T",
      target,
      workspace: { mode: "copy", path: target },
      participants: [{ id: "codex", kind: "worker", transport: "codex" }],
      runtime: { port: null, orchestratorSessionID: "x", participants: [{ id: "codex", kind: "worker", transport: "codex" }] },
      budget: { maxSteps: 3, maxTokens: 1000 },
      maxSummaryChars: 2000,
      codexMode: "exec",
    },
  });
  appendLine(path.join(dir, "orch-ledger.jsonl"), {
    kind: "worker-started",
    step: 1,
    worker: "codex",
    subtask: "edit target",
  });

  const out = okJson(runBridge(dir, ["orchestrate", "resume"]));
  const events = fs.readFileSync(path.join(dir, "orch-ledger.jsonl"), "utf8").trim().split(/\r?\n/);

  assert.equal(out.event, "orchestrate-resume-blocked");
  assert.equal(out.tokenSpending, false);
  assert.equal(out.pending.worker, "codex");
  assert.equal(events.length, 2);
});
