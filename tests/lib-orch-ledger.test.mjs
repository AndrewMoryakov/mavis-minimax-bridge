import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ambiguousTail,
  appendOrchEvent,
  projectOrchState,
  readOrchLedger,
  writeOrchState,
} from "../lib/orch-ledger.mjs";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-orch-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("appendOrchEvent writes seq timestamps and projectOrchState summarizes", (t) => {
  const dir = sandbox(t);
  const ledger = path.join(dir, "orch-ledger.jsonl");
  const now = () => new Date("2026-07-01T00:00:00.000Z");

  appendOrchEvent(ledger, { kind: "init", step: 0 }, now);
  appendOrchEvent(ledger, { kind: "decision", step: 1, decision: { action: "run", worker: "codex" }, usage: { inputTokens: 10 } }, now);
  appendOrchEvent(ledger, { kind: "final", step: 1, status: "done", usage: { outputTokens: 5 } }, now);

  const { events, dropped } = readOrchLedger(ledger);
  assert.equal(dropped, 0);
  assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
  assert.deepEqual(projectOrchState(events), {
    status: "done",
    step: 1,
    spent: { tokens: 15 },
    lastDecision: { action: "run", worker: "codex" },
  });
});

test("readOrchLedger reports dropped corrupt lines and ambiguousTail detects worker-started", (t) => {
  const dir = sandbox(t);
  const ledger = path.join(dir, "orch-ledger.jsonl");
  fs.writeFileSync(ledger, [
    JSON.stringify({ kind: "init", step: 0 }),
    "{broken",
    JSON.stringify({ kind: "worker-started", step: 1, worker: "codex", subtask: "edit" }),
  ].join("\n"), "utf8");

  const { events, dropped } = readOrchLedger(ledger);
  assert.equal(dropped, 1);
  assert.deepEqual(ambiguousTail(events), { worker: "codex", subtask: "edit", step: 1 });
});

test("appendOrchEvent sequences after corrupt lines by physical ledger line", (t) => {
  const dir = sandbox(t);
  const ledger = path.join(dir, "orch-ledger.jsonl");
  fs.writeFileSync(ledger, [
    JSON.stringify({ seq: 0, kind: "init" }),
    "{broken",
  ].join("\n"), "utf8");

  const event = appendOrchEvent(ledger, { kind: "final" }, () => new Date("2026-07-01T00:00:00.000Z"));
  assert.equal(event.seq, 2);
});

test("writeOrchState writes stable json", (t) => {
  const filePath = path.join(sandbox(t), "orch-state.json");
  writeOrchState(filePath, { status: "running" });
  assert.equal(fs.readFileSync(filePath, "utf8"), "{\n  \"status\": \"running\"\n}\n");
});
