import assert from "node:assert/strict";
import test from "node:test";

import { makeBudget } from "../lib/orch-budget.mjs";
import { runOrchestratorLoop } from "../lib/orchestrator.mjs";

test("runOrchestratorLoop drives decision to worker result to done", async () => {
  const events = [];
  const decisions = [
    { decision: { action: "run", worker: "codex", subtask: "edit file" }, usage: { inputTokens: 10 } },
    { decision: { action: "done", summary: "complete" }, usage: { outputTokens: 5 } },
  ];
  const summariesSeen = [];
  const orchestrator = {
    decide: async (summary) => {
      summariesSeen.push(summary);
      return decisions.shift();
    },
  };
  const workerRunner = {
    run: async (worker, subtask, { step }) => ({
      summary: { worker, step, status: "ok", did: subtask, artifacts: [], rawRef: null, truncated: false },
      usage: { inputTokens: 3, outputTokens: 2 },
    }),
  };

  const result = await runOrchestratorLoop({
    orchestrator,
    workerRunner,
    budget: makeBudget({ maxSteps: 5, maxTokens: 1000 }),
    appendEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { status: "done", steps: 2 });
  assert.deepEqual(events.map((event) => event.kind), ["decision", "worker-started", "worker-result", "decision", "final"]);
  assert.equal(summariesSeen[0], null);
  assert.equal(summariesSeen[1].did, "edit file");
});

test("runOrchestratorLoop turns worker failure into worker-result summary", async () => {
  const events = [];
  const decisions = [
    { decision: { action: "run", worker: "codex", subtask: "edit" }, usage: {} },
    { decision: { action: "escalate", reason: "worker failed" }, usage: {} },
  ];
  const result = await runOrchestratorLoop({
    orchestrator: { decide: async () => decisions.shift() },
    workerRunner: { run: async () => { throw new Error("boom"); } },
    budget: makeBudget({ maxSteps: 5, maxTokens: 1000 }),
    appendEvent: (event) => events.push(event),
  });

  const workerResult = events.find((event) => event.kind === "worker-result");
  assert.equal(workerResult.summary.status, "error");
  assert.match(workerResult.summary.did, /boom/);
  assert.equal(result.status, "human_escalation");
});

test("runOrchestratorLoop stops on step budget", async () => {
  const events = [];
  const result = await runOrchestratorLoop({
    orchestrator: { decide: async () => ({ decision: { action: "run", worker: "codex", subtask: "again" }, usage: {} }) },
    workerRunner: { run: async () => ({ summary: { status: "ok" }, usage: {} }) },
    budget: makeBudget({ maxSteps: 1, maxTokens: 1000 }),
    appendEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "budget_exhausted");
  assert.equal(events.at(-1).kind, "final");
  assert.equal(events.at(-1).status, "budget_exhausted");
});
