import assert from "node:assert/strict";
import test from "node:test";

import { makeWorkerRunner } from "../lib/orch-workers.mjs";

test("makeWorkerRunner writes raw output and returns bounded worker summary", async () => {
  const rawWrites = [];
  const runner = makeWorkerRunner({
    participants: [{ id: "codex", kind: "worker" }],
    goal: "ship",
    maxSummaryChars: 80,
    writeRaw: (name, text) => {
      rawWrites.push({ name, text });
      return { path: name, sha256: "abc", bytes: text.length };
    },
    runWorker: async (_participant, prompt) => ({
      rawOutput: `${prompt}\n\n{"did":"edited files"}`,
      usage: { outputTokens: 3 },
    }),
  });

  const out = await runner.run("codex", "edit files", { step: 1 });

  assert.equal(out.summary.worker, "codex");
  assert.equal(out.summary.did, "edited files");
  assert.equal(out.summary.rawRef.path, "1-codex.raw.txt");
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].text, /Scoped Subtask/);
  assert.equal(out.usage.outputTokens, 3);
});

test("makeWorkerRunner turns worker failures into error summaries", async () => {
  const runner = makeWorkerRunner({
    participants: [{ id: "minimax", kind: "worker" }],
    writeRaw: (name, text) => ({ path: name, sha256: "abc", bytes: text.length }),
    runWorker: async () => {
      throw new Error("transport failed");
    },
  });

  const out = await runner.run("minimax", "review", { step: 2 });

  assert.equal(out.summary.status, "error");
  assert.match(out.summary.did, /transport failed/);
  assert.equal(out.summary.rawRef.path, "2-minimax.error.txt");
});
