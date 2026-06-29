# Local Supervised Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `orchestrate` command where a local, supervised LLM orchestrator owns a task and routes scoped sub-tasks to `codex`/`minimax` workers, recording everything to an append-only log, with a human in the loop as the recovery actor.

**Architecture:** Additive layer beside the duet relay (approach A). Pure leaf modules (decision parsing, worker-summary, ledger, target validation, budget) are built and tested first, then the worker-runner and orchestrator-runner adapters over the existing `lib/` transports, then the loop, then CLI dispatch. The append-only `orch-ledger.jsonl` is the durable record; recovery is one human-decision rule. Nothing in the duet relay is touched.

**Tech Stack:** Node.js 20+ ESM, zero runtime deps, `node:test`, real `node:http` test servers, the existing `fakeModelReplyFromEnv` test hook, `lib/` transports (`codex-exec`, `mvs-client`, `http-json`, `path-security`, `text-utils`, `duet-lock`).

## Global Constraints

- This is a **local supervised orchestrator**, NOT production/unattended. Durability is for observability + manual decision, not automatic recovery. (spec banner)
- No new runtime dependencies (zero-dep posture).
- No module under `lib/` may import `bridge.mjs`; `bridgeDir` is injected, never recomputed inside `lib/`.
- Every task keeps `npm run test:release` green (`node --check` + offline tests + `git diff --check`).
- The duet relay and its files are untouched; orchestrator state files are all `orch-*`, guarded by a separate `orch.lock` via the `lib/duet-lock` helper.
- Tests are offline and token-free: codex via `fakeModelReplyFromEnv`; MiniMax/orchestrator via a local `node:http` server + scripted replies. Each test is mutation-meaningful.
- The orchestrator only ever receives bounded worker-summaries (never raw output); decisions are schema-validated, fail-closed; `worker` is validated against the participant registry, never against `"codex"/"minimax"` literals.
- TDD: RED → GREEN → refactor; small commits per task.

**Resolved defaults** (were open items in the spec):
- Orchestrator transport = the MiniMax/opencode `sendPrompt` path on a dedicated session; model from `config.orchestratorModel` (falls back to `config` default route).
- `maxSummaryChars` = 2000; `maxSteps` = 20; `maxTokens` = `config.orchestratorMaxTokens || 200000`; per-call `reserve` = the input-token estimate of the prompt being sent (via existing `estimateInputTokensForText`).
- Codex worker memory = persistent per-task git worktree (files persist) + bounded re-injection of prior `{subtask → summary}`; native codex resume is NOT in the MVP.

---

### Task 1: Decision schema parser (`lib/orch-decision.mjs`)

**Files:**
- Create: `lib/orch-decision.mjs`
- Test: `tests/lib-orch-decision.test.mjs`

**Interfaces:**
- Produces: `parseOrchestratorDecision(text: string, workerIds: string[]): {action, worker?, subtask?, summary?, reason?, note?}` — extracts the first JSON block, validates against the schema, throws `Error` with a stable message on any violation (fail-closed). `workerIds` is the registry's worker id list.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseOrchestratorDecision } from "../lib/orch-decision.mjs";

const WORKERS = ["codex", "minimax"];

test("parseOrchestratorDecision accepts a valid run decision", () => {
  const text = 'noise\n```json\n{"action":"run","worker":"codex","subtask":"do X","note":"why"}\n```';
  assert.deepEqual(parseOrchestratorDecision(text, WORKERS), {
    action: "run", worker: "codex", subtask: "do X", note: "why",
  });
});

test("parseOrchestratorDecision accepts done and escalate", () => {
  assert.deepEqual(parseOrchestratorDecision('{"action":"done","summary":"finished"}', WORKERS),
    { action: "done", summary: "finished" });
  assert.deepEqual(parseOrchestratorDecision('{"action":"escalate","reason":"stuck"}', WORKERS),
    { action: "escalate", reason: "stuck" });
});

test("parseOrchestratorDecision rejects invalid decisions (fail-closed)", () => {
  assert.throws(() => parseOrchestratorDecision("no json here", WORKERS), /no decision JSON/);
  assert.throws(() => parseOrchestratorDecision('{"action":"sing"}', WORKERS), /invalid action/);
  assert.throws(() => parseOrchestratorDecision('{"action":"run","worker":"gpt","subtask":"x"}', WORKERS), /unknown worker/);
  assert.throws(() => parseOrchestratorDecision('{"action":"run","worker":"codex","subtask":""}', WORKERS), /subtask is required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orch-decision.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (module missing).

- [ ] **Step 3: Write minimal implementation**

```js
const ACTIONS = ["run", "done", "escalate"];

function extractJsonBlock(text) {
  const fenced = String(text || "").match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidate = fenced ? fenced[1] : (String(text || "").match(/\{[\s\S]*\}/) || [])[0];
  if (!candidate) throw new Error("no decision JSON in orchestrator output");
  try {
    return JSON.parse(candidate);
  } catch (_) {
    throw new Error("no decision JSON in orchestrator output: not valid JSON");
  }
}

export function parseOrchestratorDecision(text, workerIds) {
  const raw = extractJsonBlock(text);
  const action = String(raw.action || "").toLowerCase();
  if (!ACTIONS.includes(action)) throw new Error(`invalid action: ${raw.action}`);
  if (action === "run") {
    if (!workerIds.includes(raw.worker)) throw new Error(`unknown worker: ${raw.worker}`);
    if (!raw.subtask || !String(raw.subtask).trim()) throw new Error("subtask is required for run");
    const out = { action, worker: raw.worker, subtask: String(raw.subtask) };
    if (raw.note !== undefined) out.note = String(raw.note);
    return out;
  }
  const out = { action };
  if (action === "done") out.summary = String(raw.summary || "");
  if (action === "escalate") out.reason = String(raw.reason || "");
  if (raw.note !== undefined) out.note = String(raw.note);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orch-decision.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/orch-decision.mjs tests/lib-orch-decision.test.mjs
git commit -m "Add orchestrator decision schema parser"
```

---

### Task 2: Worker-summary contract (`lib/worker-summary.mjs`)

**Files:**
- Create: `lib/worker-summary.mjs`
- Test: `tests/lib-worker-summary.test.mjs`

**Interfaces:**
- Consumes: `textSummary` from `lib/text-utils.mjs`.
- Produces: `buildWorkerSummary({ worker, step, status, rawOutput, selfReport, artifacts, rawRef, maxSummaryChars }): { worker, step, status, did, artifacts, rawRef, truncated }` — uses `selfReport.did` when present and valid, else synthesizes from a capped head/tail of `rawOutput`; always caps `did` at `maxSummaryChars`; never includes raw bytes beyond the cap.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerSummary } from "../lib/worker-summary.mjs";

test("buildWorkerSummary uses a valid self-report, capped", () => {
  const s = buildWorkerSummary({
    worker: "codex", step: 1, status: "ok", rawOutput: "x".repeat(9000),
    selfReport: { did: "edited a.js" }, artifacts: [{ path: "a.js", sha256: "ab", bytes: 10 }],
    rawRef: { path: "orch-artifacts/1-codex.raw", sha256: "cd", bytes: 9000 }, maxSummaryChars: 2000,
  });
  assert.equal(s.did, "edited a.js");
  assert.equal(s.status, "ok");
  assert.equal(s.artifacts[0].path, "a.js");
  assert.equal(s.rawRef.bytes, 9000);
  assert.equal(s.truncated, false);
});

test("buildWorkerSummary synthesizes a capped did when self-report is missing", () => {
  const s = buildWorkerSummary({
    worker: "codex", step: 2, status: "ok", rawOutput: "y".repeat(9000),
    selfReport: null, artifacts: [], rawRef: { path: "r", sha256: "e", bytes: 9000 }, maxSummaryChars: 100,
  });
  assert.ok(s.did.length <= 100);
  assert.equal(s.truncated, true);
  assert.ok(!s.did.includes("y".repeat(101)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-worker-summary.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
function synthesizeDid(rawOutput, maxSummaryChars) {
  const text = String(rawOutput || "");
  if (text.length <= maxSummaryChars) return text;
  const half = Math.max(1, Math.floor((maxSummaryChars - 20) / 2));
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

export function buildWorkerSummary({ worker, step, status, rawOutput, selfReport, artifacts, rawRef, maxSummaryChars }) {
  const reported = selfReport && typeof selfReport.did === "string" && selfReport.did.trim()
    ? selfReport.did
    : synthesizeDid(rawOutput, maxSummaryChars);
  const truncated = reported.length > maxSummaryChars || String(rawOutput || "").length > maxSummaryChars;
  const did = reported.length > maxSummaryChars ? reported.slice(0, maxSummaryChars) : reported;
  return {
    worker, step, status: status || "ok",
    did,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    rawRef: rawRef || null,
    truncated,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-worker-summary.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/worker-summary.mjs tests/lib-worker-summary.test.mjs
git commit -m "Add worker-summary contract helper"
```

---

### Task 3: Target validation (`lib/orch-target.mjs`)

**Files:**
- Create: `lib/orch-target.mjs`
- Test: `tests/lib-orch-target.test.mjs`

**Interfaces:**
- Consumes: `realpathOrResolve`, `isPathInsideRoot` from `lib/path-security.mjs`.
- Produces: `validateTarget(targetDir: string, bridgeDir: string): string` — returns the realpath of the target, or throws if target equals / is inside / contains `bridgeDir`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateTarget } from "../lib/orch-target.mjs";

function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-target-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("validateTarget accepts a sibling dir and rejects bridge overlaps", (t) => {
  const bridge = tmp(t);
  const target = tmp(t); // sibling
  assert.equal(validateTarget(target, bridge), fs.realpathSync(target));
  assert.throws(() => validateTarget(bridge, bridge), /target/);
  const inside = path.join(bridge, "sub"); fs.mkdirSync(inside);
  assert.throws(() => validateTarget(inside, bridge), /inside/);
  const parent = path.dirname(bridge);
  assert.throws(() => validateTarget(parent, bridge), /contains/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orch-target.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
import { isPathInsideRoot, realpathOrResolve } from "./path-security.mjs";

export function validateTarget(targetDir, bridgeDir) {
  const target = realpathOrResolve(targetDir);
  const root = realpathOrResolve(bridgeDir);
  if (target === root) throw new Error("target must not be the bridge directory");
  if (isPathInsideRoot(root, target)) throw new Error("target must not be inside the bridge directory");
  if (isPathInsideRoot(target, root)) throw new Error("target must not contain the bridge directory");
  return target;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orch-target.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/orch-target.mjs tests/lib-orch-target.test.mjs
git commit -m "Add orchestrator target validation"
```

---

### Task 4: Append-only ledger + projection + recovery (`lib/orch-ledger.mjs`)

**Files:**
- Create: `lib/orch-ledger.mjs`
- Test: `tests/lib-orch-ledger.test.mjs`

**Interfaces:**
- Produces:
  - `appendOrchEvent(ledgerPath, event, now): object` — appends `{seq, ...event, ts:now()}` (seq = current line count) as one JSONL line; returns the written event.
  - `readOrchLedger(ledgerPath): object[]` — reads all events (tolerant of a trailing partial line).
  - `projectOrchState(events): { task, target, status, step, spent, lastDecision, participants }` — folds the log into the compact projection.
  - `ambiguousTail(events): {worker, subtask, step} | null` — returns the pending worker if the last event is a `worker-started` with no following `worker-result`, else null.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendOrchEvent, readOrchLedger, projectOrchState, ambiguousTail } from "../lib/orch-ledger.mjs";

function ledger(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ledger-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, "orch-ledger.jsonl");
}
const NOW = () => "2026-06-29T00:00:00.000Z";

test("appendOrchEvent assigns increasing seq and readOrchLedger round-trips", (t) => {
  const p = ledger(t);
  appendOrchEvent(p, { kind: "init", payload: { task: "T", target: "/x" } }, NOW);
  appendOrchEvent(p, { kind: "decision", payload: { action: "run", worker: "codex", subtask: "S" }, usage: { output_tokens: 5 } }, NOW);
  const events = readOrchLedger(p);
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 0);
  assert.equal(events[1].seq, 1);
});

test("projectOrchState folds the log", (t) => {
  const p = ledger(t);
  appendOrchEvent(p, { kind: "init", payload: { task: "T", target: "/x" } }, NOW);
  appendOrchEvent(p, { kind: "decision", step: 1, payload: { action: "run", worker: "codex", subtask: "S" }, usage: { output_tokens: 5 } }, NOW);
  appendOrchEvent(p, { kind: "worker-started", step: 1, worker: "codex", subtask: "S" }, NOW);
  appendOrchEvent(p, { kind: "worker-result", step: 1, worker: "codex", status: "ok", usage: { output_tokens: 7 } }, NOW);
  const s = projectOrchState(readOrchLedger(p));
  assert.equal(s.task, "T");
  assert.equal(s.status, "running");
  assert.equal(s.step, 1);
  assert.equal(s.spent, 12);
});

test("ambiguousTail flags an interrupted worker-started", (t) => {
  const p = ledger(t);
  appendOrchEvent(p, { kind: "init", payload: { task: "T", target: "/x" } }, NOW);
  appendOrchEvent(p, { kind: "worker-started", step: 1, worker: "codex", subtask: "S" }, NOW);
  assert.deepEqual(ambiguousTail(readOrchLedger(p)), { worker: "codex", subtask: "S", step: 1 });
  appendOrchEvent(p, { kind: "worker-result", step: 1, worker: "codex", status: "ok" }, NOW);
  assert.equal(ambiguousTail(readOrchLedger(p)), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orch-ledger.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
import fs from "node:fs";

export function readOrchLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

export function appendOrchEvent(ledgerPath, event, now) {
  const seq = readOrchLedger(ledgerPath).length;
  const record = { seq, ts: now(), ...event };
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function projectOrchState(events) {
  const state = { task: null, target: null, status: "running", step: 0, spent: 0, lastDecision: null, participants: [] };
  for (const e of events) {
    if (e.kind === "init") {
      state.task = e.payload?.task ?? null;
      state.target = e.payload?.target ?? null;
      state.participants = e.payload?.participants ?? [];
    }
    if (typeof e.step === "number") state.step = Math.max(state.step, e.step);
    if (e.usage?.output_tokens) state.spent += Number(e.usage.output_tokens) || 0;
    if (e.kind === "decision") state.lastDecision = e.payload || null;
    if (e.kind === "final") state.status = e.payload?.action === "escalate" ? "escalated" : "done";
  }
  return state;
}

export function ambiguousTail(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind === "worker-result") return null;
    if (events[i].kind === "worker-started") {
      return { worker: events[i].worker, subtask: events[i].subtask, step: events[i].step };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orch-ledger.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/orch-ledger.mjs tests/lib-orch-ledger.test.mjs
git commit -m "Add orchestrator append-only ledger and projection"
```

---

### Task 5: Honest budget gate (`lib/orch-budget.mjs`)

**Files:**
- Create: `lib/orch-budget.mjs`
- Test: `tests/lib-orch-budget.test.mjs`

**Interfaces:**
- Produces: `makeBudget({ maxSteps, maxTokens }): { canStartCall(reserveTokens): boolean, canStartStep(step): boolean, account(usageTokens): void, spent(): number }` — `canStartCall` returns `spent + reserve <= maxTokens`; `account` adds actual usage after a call.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { makeBudget } from "../lib/orch-budget.mjs";

test("budget stops before a call that would exceed and accounts post-fact", () => {
  const b = makeBudget({ maxSteps: 3, maxTokens: 100 });
  assert.equal(b.canStartStep(2), true);
  assert.equal(b.canStartStep(3), false);
  assert.equal(b.canStartCall(60), true);
  b.account(70);
  assert.equal(b.spent(), 70);
  assert.equal(b.canStartCall(40), false); // 70 + 40 > 100
  assert.equal(b.canStartCall(20), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orch-budget.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
export function makeBudget({ maxSteps, maxTokens }) {
  let used = 0;
  return {
    canStartStep: (step) => step < maxSteps,
    canStartCall: (reserveTokens) => used + Math.max(0, Number(reserveTokens) || 0) <= maxTokens,
    account: (usageTokens) => { used += Math.max(0, Number(usageTokens) || 0); },
    spent: () => used,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orch-budget.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/orch-budget.mjs tests/lib-orch-budget.test.mjs
git commit -m "Add orchestrator honest budget gate"
```

---

### Task 6: Worker-runner adapter (`lib/orch-workers.mjs`)

**Files:**
- Create: `lib/orch-workers.mjs`
- Test: `tests/lib-orch-workers.test.mjs`

**Interfaces:**
- Consumes: `buildWorkerSummary` (Task 2); injected `runWorker(participant, prompt)` so the test can supply a fake without spawning real codex/MiniMax.
- Produces: `makeWorkerRunner({ participants, runWorker, maxSummaryChars, writeRaw }): { run(workerId, subtask, goal): Promise<workerSummary> }` — builds the worker prompt (scoped subtask + goal background + bounded prior-turn re-injection for codex), calls `runWorker`, writes raw via `writeRaw` and returns `buildWorkerSummary(...)`. On a thrown `runWorker`, returns a summary with `status: "error"`.

Note: this task abstracts the transport call behind `runWorker` (dependency injection). Wiring `runWorker` to the real `runCodexExecTurn` / `sendPrompt` happens in Task 8/9; here it is injected so the runner is unit-tested offline.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { makeWorkerRunner } from "../lib/orch-workers.mjs";

const PARTICIPANTS = [
  { id: "codex", kind: "worker", transport: "codex", memory: "workspace+reinject" },
  { id: "minimax", kind: "worker", transport: "opencode-http", memory: "native-session" },
];

test("worker-runner returns a bounded summary on success", async () => {
  const writes = [];
  const runner = makeWorkerRunner({
    participants: PARTICIPANTS,
    runWorker: async () => ({ rawOutput: "did the thing", selfReport: { did: "did the thing" }, status: "ok", usage: { output_tokens: 9 } }),
    maxSummaryChars: 2000,
    writeRaw: (name, content) => { writes.push({ name, bytes: content.length }); return { path: name, sha256: "x", bytes: content.length }; },
  });
  const { summary } = await runner.run("codex", "do X", "the goal", 1);
  assert.equal(summary.status, "ok");
  assert.equal(summary.did, "did the thing");
  assert.equal(writes.length, 1);
});

test("worker-runner reports a thrown worker as error, not a throw", async () => {
  const runner = makeWorkerRunner({
    participants: PARTICIPANTS,
    runWorker: async () => { throw new Error("codex exited 1"); },
    maxSummaryChars: 2000,
    writeRaw: () => ({ path: "r", sha256: "x", bytes: 0 }),
  });
  const { summary } = await runner.run("codex", "do X", "the goal", 1);
  assert.equal(summary.status, "error");
  assert.match(summary.did, /codex exited 1/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orch-workers.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
import { buildWorkerSummary } from "./worker-summary.mjs";

export function makeWorkerRunner({ participants, runWorker, maxSummaryChars, writeRaw, priorTurns = () => "" }) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  return {
    async run(workerId, subtask, goal, step = 0) {
      const participant = byId.get(workerId);
      if (!participant) throw new Error(`unknown worker: ${workerId}`);
      const prior = participant.memory === "workspace+reinject" ? priorTurns(workerId) : "";
      const prompt = [
        `# Goal (background)\n${goal}`,
        prior ? `# Your prior turns\n${prior}` : "",
        `# This sub-task\n${subtask}`,
      ].filter(Boolean).join("\n\n");
      try {
        const r = await runWorker(participant, prompt);
        const rawRef = writeRaw(`${step}-${workerId}.raw`, String(r.rawOutput || ""));
        return { summary: buildWorkerSummary({ worker: workerId, step, status: r.status || "ok", rawOutput: r.rawOutput, selfReport: r.selfReport, artifacts: r.artifacts || [], rawRef, maxSummaryChars }), usage: r.usage || {} };
      } catch (error) {
        const rawRef = writeRaw(`${step}-${workerId}.raw`, String(error.message || error));
        return { summary: buildWorkerSummary({ worker: workerId, step, status: "error", rawOutput: String(error.message || error), selfReport: null, artifacts: [], rawRef, maxSummaryChars }), usage: {} };
      }
    },
  };
}
```

`run(...)` returns `{ summary, usage }` (the loop in Task 8 reads both); the tests above destructure `{ summary }` accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orch-workers.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/orch-workers.mjs tests/lib-orch-workers.test.mjs
git commit -m "Add orchestrator worker-runner adapter"
```

---

### Task 7: Orchestrator-runner adapter (`lib/orch-runner.mjs`)

**Files:**
- Create: `lib/orch-runner.mjs`
- Test: `tests/lib-orch-runner.test.mjs`

**Interfaces:**
- Consumes: `parseOrchestratorDecision` (Task 1); injected `askOrchestrator(prompt): Promise<{text, usage}>` so tests supply scripted replies without a real model.
- Produces: `makeOrchestrator({ workerIds, askOrchestrator, systemPrompt }): { decide(lastSummary): Promise<{decision, usage}> }` — composes the orchestrator prompt (system prompt + last bounded summary), calls `askOrchestrator`, parses the decision fail-closed (one re-ask on parse failure, then `escalate`).

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { makeOrchestrator } from "../lib/orch-runner.mjs";

test("orchestrator parses a scripted decision", async () => {
  const o = makeOrchestrator({
    workerIds: ["codex", "minimax"],
    askOrchestrator: async () => ({ text: '{"action":"run","worker":"codex","subtask":"go"}', usage: { output_tokens: 3 } }),
    systemPrompt: "SYS",
  });
  const { decision } = await o.decide("prior summary");
  assert.deepEqual(decision, { action: "run", worker: "codex", subtask: "go" });
});

test("orchestrator re-asks once then escalates on persistent garbage", async () => {
  let calls = 0;
  const o = makeOrchestrator({
    workerIds: ["codex"],
    askOrchestrator: async () => { calls += 1; return { text: "not json", usage: { output_tokens: 1 } }; },
    systemPrompt: "SYS",
  });
  const { decision } = await o.decide(null);
  assert.equal(decision.action, "escalate");
  assert.equal(calls, 2); // original + one re-ask
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orch-runner.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
import { parseOrchestratorDecision } from "./orch-decision.mjs";

export function makeOrchestrator({ workerIds, askOrchestrator, systemPrompt }) {
  async function ask(extra) {
    const r = await askOrchestrator([systemPrompt, extra].filter(Boolean).join("\n\n"));
    return r;
  }
  return {
    async decide(lastSummary) {
      const input = lastSummary ? `# Prior step summary (untrusted)\n${JSON.stringify(lastSummary)}` : "# Begin the task";
      let totalUsage = 0;
      let r = await ask(input);
      totalUsage += Number(r.usage?.output_tokens) || 0;
      try {
        return { decision: parseOrchestratorDecision(r.text, workerIds), usage: { output_tokens: totalUsage } };
      } catch (_) {
        r = await ask(`${input}\n\nYour last output was not a valid decision JSON. Return ONLY the JSON object.`);
        totalUsage += Number(r.usage?.output_tokens) || 0;
        try {
          return { decision: parseOrchestratorDecision(r.text, workerIds), usage: { output_tokens: totalUsage } };
        } catch (e) {
          return { decision: { action: "escalate", reason: `orchestrator produced no valid decision: ${e.message}` }, usage: { output_tokens: totalUsage } };
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orch-runner.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/orch-runner.mjs tests/lib-orch-runner.test.mjs
git commit -m "Add orchestrator-runner adapter"
```

---

### Task 8: The loop (`lib/orchestrator.mjs`)

**Files:**
- Create: `lib/orchestrator.mjs`
- Test: `tests/lib-orchestrator.test.mjs`

**Interfaces:**
- Consumes: `makeOrchestrator` (T7), `makeWorkerRunner` (T6), `makeBudget` (T5), `appendOrchEvent`/`projectOrchState`/`ambiguousTail` (T4).
- Produces: `runOrchestratorLoop({ ledgerPath, orchestrator, workerRunner, budget, goal, appendEvent, journal }): Promise<{ status, steps }>` — drives ask→run→record until `done`/`escalate`/cap, writing `decision`/`worker-started`/`worker-result`/`final` events.

- [ ] **Step 1: Write the failing test** (scripted, fully offline — drives a 2-step run to `done`)

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOrchestratorLoop } from "../lib/orchestrator.mjs";
import { readOrchLedger } from "../lib/orch-ledger.mjs";
import { appendOrchEvent } from "../lib/orch-ledger.mjs";
import { makeBudget } from "../lib/orch-budget.mjs";

const NOW = () => "2026-06-29T00:00:00.000Z";

function ledger(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orch-loop-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, "orch-ledger.jsonl");
}

test("the loop runs a scripted codex turn then finishes", async (t) => {
  const p = ledger(t);
  const decisions = [
    { decision: { action: "run", worker: "codex", subtask: "edit" }, usage: { output_tokens: 2 } },
    { decision: { action: "done", summary: "finished" }, usage: { output_tokens: 2 } },
  ];
  const orchestrator = { decide: async () => decisions.shift() };
  const workerRunner = { run: async () => ({ summary: { worker: "codex", step: 1, status: "ok", did: "edited", artifacts: [], rawRef: null, truncated: false }, usage: { output_tokens: 4 } }) };
  const out = await runOrchestratorLoop({
    ledgerPath: p, orchestrator, workerRunner, budget: makeBudget({ maxSteps: 10, maxTokens: 1000 }),
    goal: "do the task", appendEvent: (ev) => appendOrchEvent(p, ev, NOW), journal: () => {},
  });
  assert.equal(out.status, "done");
  const kinds = readOrchLedger(p).map((e) => e.kind);
  assert.deepEqual(kinds, ["decision", "worker-started", "worker-result", "decision", "final"]);
});

test("the loop stops at the step cap with escalate", async (t) => {
  const p = ledger(t);
  const orchestrator = { decide: async () => ({ decision: { action: "run", worker: "codex", subtask: "x" }, usage: { output_tokens: 1 } }) };
  const workerRunner = { run: async () => ({ summary: { status: "ok", did: "x" }, usage: { output_tokens: 1 } }) };
  const out = await runOrchestratorLoop({
    ledgerPath: p, orchestrator, workerRunner, budget: makeBudget({ maxSteps: 2, maxTokens: 1000 }),
    goal: "g", appendEvent: (ev) => appendOrchEvent(p, ev, NOW), journal: () => {},
  });
  assert.equal(out.status, "escalated");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-orchestrator.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

```js
export async function runOrchestratorLoop({ ledgerPath, orchestrator, workerRunner, budget, goal, appendEvent, journal }) {
  let step = 0;
  let lastSummary = null;
  while (true) {
    if (!budget.canStartStep(step)) {
      appendEvent({ kind: "final", step, payload: { action: "escalate", reason: "max steps reached" } });
      return { status: "escalated", steps: step };
    }
    const { decision, usage } = await orchestrator.decide(lastSummary);
    budget.account(usage?.output_tokens);
    appendEvent({ kind: "decision", step, payload: decision, usage });
    journal(`decision: ${JSON.stringify(decision)}`);

    if (decision.action === "done" || decision.action === "escalate") {
      appendEvent({ kind: "final", step, payload: decision });
      return { status: decision.action === "done" ? "done" : "escalated", steps: step };
    }
    step += 1;
    appendEvent({ kind: "worker-started", step, worker: decision.worker, subtask: decision.subtask });
    const { summary, usage: wUsage } = await workerRunner.run(decision.worker, decision.subtask, goal, step);
    budget.account(wUsage?.output_tokens);
    appendEvent({ kind: "worker-result", step, worker: decision.worker, status: summary.status, summaryRef: summary, usage: wUsage });
    journal(`worker ${decision.worker}: ${summary.did}`);
    lastSummary = summary;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-orchestrator.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator.mjs tests/lib-orchestrator.test.mjs
git commit -m "Add orchestrator loop"
```

---

### Task 9: CLI wiring + runtime files + docs (`bridge.mjs`)

**Files:**
- Modify: `bridge.mjs` (add `orchestrate` dispatch + `orchestrateStartCommand`/`orchestrateStatusCommand`/`orchestrateResumeCommand`, wiring the lib modules to real transports)
- Modify: `.gitignore` (add `/orch-*` and `/orch-artifacts/`)
- Modify: `package.json` (do NOT add `orch-*` to `files`; confirm absence)
- Create: `docs/ORCHESTRATE.md` (usage), update `docs/RUNTIME_FILES.md`
- Test: `tests/bridge-orchestrate.test.mjs` (end-to-end via the sandbox harness, codex via `fakeModelReplyFromEnv`, MiniMax/orchestrator via a local `node:http` server)

**Interfaces:**
- Consumes: all of `lib/orch-*.mjs` + `runCodexExecTurn` (codex worker), `sendPrompt`/`createSession` (minimax worker + orchestrator), `withFileLockAsync` (orch.lock), `now`, `appendJsonl`.
- Produces: CLI commands `orchestrate start --task <f> --target <dir> --yes`, `orchestrate status`, `orchestrate resume`.

- [ ] **Step 1: Write the failing test** (end-to-end happy path; orchestrator + minimax via scripted local server, no real spend)

```js
// tests/bridge-orchestrate.test.mjs — model the harness on tests/bridge-cli.test.mjs:
// sandbox(t), runBridge(dir, args), ok(result), a local http.createServer for the
// opencode/mavis endpoints, and MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY for any codex turn.
// Assert: `orchestrate start --task TASK.md --target <repo> --yes --raw` exits 0,
// writes orch-ledger.jsonl whose kinds end with "final", and `orchestrate status`
// reports status "done". (Full scripted-server wiring written here.)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bridge-orchestrate.test.mjs`
Expected: FAIL (command `orchestrate` unknown).

- [ ] **Step 3: Write minimal implementation**

Add to `bridge.mjs`: the `orchestrate` command branch in the dispatcher; `orchestrateStartCommand(args)` that (1) `requireYes`, (2) `validateTarget`, (3) creates the worktree/sessions, (4) builds `makeOrchestrator`/`makeWorkerRunner`/`makeBudget` with `runWorker` wired to `runCodexExecTurn` (codex) and `sendPrompt` (minimax), (5) runs `runOrchestratorLoop` under `withFileLockAsync(orchLockPath, …)`, appending via `appendOrchEvent(orchLedgerPath, ev, now)` and writing the projection to `orch-state.json`; `orchestrateStatusCommand` prints `projectOrchState(readOrchLedger(...))`; `orchestrateResumeCommand` replays and, on an `ambiguousTail`, prints the pending worker + `git status` and exits asking the human to choose (no auto-rerun). Wire `priorTurns` from the ledger's prior `worker-result` summaries (char-bounded). Add `orch-*` to `.gitignore`.

- [ ] **Step 4: Run test + full gate**

Run: `node --test tests/bridge-orchestrate.test.mjs` → PASS
Run: `npm run test:release` → all green
Run: `node bridge.mjs orchestrate status` (no active task) → clean "no orchestrator task" message

- [ ] **Step 5: Commit**

```bash
git add bridge.mjs .gitignore package.json docs/ORCHESTRATE.md docs/RUNTIME_FILES.md tests/bridge-orchestrate.test.mjs
git commit -m "Wire orchestrate command and runtime files"
```

---

## Sequencing & deferred

Tasks 1–5 are pure leaves (parallelizable). Task 6/7 depend on 1–2. Task 8 depends on 4–7. Task 9 depends on all. Each ends green; `npm run test:release` after every task.

Deferred (NOT in this plan, per the spec's non-goals): native codex resume, per-turn commits, multi-case auto-recovery, parallel/fan-out workers, user-defined pipeline, a third worker (Claude) — the registry already accommodates it but the MVP ships codex+minimax.

## Self-review notes

- Spec coverage: §1 components → T1–T9; §2 data flow/log/recovery → T4, T8, T9; §3 decision protocol → T1, T7; §4a worker-summary → T2, T6; §4b/4c memory + target → T3, T6, T9; §5 termination/budget → T5, T8; §6 testing → every task is TDD offline. The "one recovery rule" → T4 `ambiguousTail` + T9 resume handling.
- The orchestrator-model and defaults open items are resolved in Global Constraints.
- Interface names are threaded: `parseOrchestratorDecision` (T1) used in T7; `buildWorkerSummary` (T2) in T6; `appendOrchEvent`/`projectOrchState`/`ambiguousTail` (T4) in T8/T9; `makeBudget` (T5) in T8/T9.
