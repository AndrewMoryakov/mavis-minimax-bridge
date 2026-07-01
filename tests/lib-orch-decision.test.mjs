import assert from "node:assert/strict";
import test from "node:test";

import { parseOrchestratorDecision } from "../lib/orch-decision.mjs";

const WORKERS = ["codex", "minimax", "claude"];

test("parseOrchestratorDecision accepts a valid run decision", () => {
  const text = 'noise\n```json\n{"action":"run","worker":"codex","subtask":"do X","note":"why"}\n```';
  assert.deepEqual(parseOrchestratorDecision(text, WORKERS), {
    action: "run",
    worker: "codex",
    subtask: "do X",
    note: "why",
  });
});

test("parseOrchestratorDecision accepts done and escalate decisions", () => {
  assert.deepEqual(parseOrchestratorDecision('{"action":"done","summary":"finished"}', WORKERS), {
    action: "done",
    summary: "finished",
  });
  assert.deepEqual(parseOrchestratorDecision('{"action":"escalate","reason":"need human"}', WORKERS), {
    action: "escalate",
    reason: "need human",
  });
});

test("parseOrchestratorDecision rejects invalid decisions fail-closed", () => {
  assert.throws(() => parseOrchestratorDecision("no json here", WORKERS), /no decision JSON/);
  assert.throws(() => parseOrchestratorDecision('{"action":"sing"}', WORKERS), /invalid action/);
  assert.throws(() => parseOrchestratorDecision('{"action":"run","worker":"gpt","subtask":"x"}', WORKERS), /unknown worker/);
  assert.throws(() => parseOrchestratorDecision('{"action":"run","worker":"codex","subtask":""}', WORKERS), /subtask is required/);
});
