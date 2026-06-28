import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  codexIsolationWarning,
  codexPromptPathForOutput,
  lastCodexUsage,
  parseCodexJsonEvents,
  requireCodexMode,
  terminateChildProcessTree,
} from "../lib/codex-exec.mjs";

test("parseCodexJsonEvents keeps json objects and tolerates diagnostics", () => {
  const text = [
    "starting codex...",
    '{"type":"a","value":1}',
    "",
    "not json",
    '{"type":"b","usage":{"output_tokens":5}}',
    "{ broken",
  ].join("\n");
  const events = parseCodexJsonEvents(text);
  assert.deepEqual(events, [
    { type: "a", value: 1 },
    { type: "b", usage: { output_tokens: 5 } },
  ]);
});

test("lastCodexUsage returns the last event usage or null", () => {
  assert.deepEqual(
    lastCodexUsage([{ usage: { a: 1 } }, { usage: { b: 2 } }, { noUsage: true }]),
    { b: 2 },
  );
  assert.equal(lastCodexUsage([{ foo: 1 }, { bar: 2 }]), null);
  assert.equal(lastCodexUsage([]), null);
});

test("requireCodexMode normalizes valid modes, falls back, and rejects others", () => {
  assert.equal(requireCodexMode("exec"), "exec");
  assert.equal(requireCodexMode("isolated"), "isolated");
  assert.equal(requireCodexMode("ISOLATED"), "isolated");
  assert.equal(requireCodexMode(undefined), "exec");
  assert.equal(requireCodexMode("", "isolated"), "isolated");
  assert.throws(() => requireCodexMode("sandboxed"), /must be isolated or exec/);
});

test("codexPromptPathForOutput swaps the pending suffix for the prompt suffix", () => {
  assert.equal(
    codexPromptPathForOutput("/work/x.pending.local.md"),
    "/work/x.prompt.local.txt",
  );
  assert.equal(
    codexPromptPathForOutput("/work/x.PENDING.LOCAL.MD"),
    "/work/x.prompt.local.txt",
  );
});

test("codexIsolationWarning flags isolated mode only", () => {
  assert.equal(
    codexIsolationWarning("isolated"),
    "codex_isolated_is_scratch_readonly_not_hard_security_boundary",
  );
  assert.equal(codexIsolationWarning("exec"), null);
});

test("terminateChildProcessTree is a noop without a pid", () => {
  assert.doesNotThrow(() => terminateChildProcessTree(null));
  assert.doesNotThrow(() => terminateChildProcessTree({}));
});

test("terminateChildProcessTree kills a running child", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  terminateChildProcessTree(child);
  await exited;
  assert.equal(child.killed || child.exitCode !== null || child.signalCode !== null, true);
});
