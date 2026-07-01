import assert from "node:assert/strict";
import test from "node:test";

import { makeOrchestrator } from "../lib/orch-runner.mjs";

test("makeOrchestrator parses a scripted valid decision", async () => {
  const orchestrator = makeOrchestrator({
    workerIds: ["codex", "minimax"],
    goal: "finish",
    systemPrompt: "SYS",
    askOrchestrator: async (prompt) => ({
      text: '{"action":"run","worker":"codex","subtask":"edit"}',
      usage: { inputTokens: prompt.length, outputTokens: 2 },
    }),
  });

  const out = await orchestrator.decide(null);

  assert.deepEqual(out.decision, { action: "run", worker: "codex", subtask: "edit" });
  assert.equal(out.usage.outputTokens, 2);
});

test("makeOrchestrator re-asks once then escalates on repeated invalid output", async () => {
  let calls = 0;
  const orchestrator = makeOrchestrator({
    workerIds: ["codex"],
    goal: "finish",
    systemPrompt: "SYS",
    askOrchestrator: async () => {
      calls += 1;
      return { text: "not json", usage: { outputTokens: 1 } };
    },
  });

  const out = await orchestrator.decide(null);

  assert.equal(calls, 2);
  assert.equal(out.decision.action, "escalate");
  assert.match(out.decision.reason, /no valid decision/);
});
