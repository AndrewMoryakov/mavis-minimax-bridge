import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerSummary } from "../lib/worker-summary.mjs";

test("buildWorkerSummary uses a valid self-report and references raw output", () => {
  const summary = buildWorkerSummary({
    worker: "codex",
    step: 1,
    status: "ok",
    rawOutput: "x".repeat(9000),
    selfReport: { did: "edited a.js" },
    artifacts: [{ path: "a.js", sha256: "ab", bytes: 10 }],
    rawRef: { path: "orch-artifacts/1-codex.raw", sha256: "cd", bytes: 9000 },
    maxSummaryChars: 2000,
  });
  assert.equal(summary.did, "edited a.js");
  assert.equal(summary.status, "ok");
  assert.equal(summary.artifacts[0].path, "a.js");
  assert.equal(summary.rawRef.bytes, 9000);
  assert.equal(summary.truncated, true);
});

test("buildWorkerSummary synthesizes a capped did when self-report is missing", () => {
  const summary = buildWorkerSummary({
    worker: "codex",
    step: 2,
    status: "ok",
    rawOutput: "y".repeat(9000),
    selfReport: null,
    artifacts: [],
    rawRef: { path: "r", sha256: "e", bytes: 9000 },
    maxSummaryChars: 100,
  });
  assert.ok(summary.did.length <= 100);
  assert.equal(summary.truncated, true);
  assert.ok(!summary.did.includes("y".repeat(101)));
});
