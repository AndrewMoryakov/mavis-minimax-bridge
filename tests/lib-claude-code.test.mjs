import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const fakeClaude = path.resolve("tests", "helpers", "fake-claude.mjs");

function parseNdjson(text) {
  const events = [];
  const malformed = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      malformed.push(line);
    }
  }
  return { events, malformed };
}

function fakeClaudeEnv(mode, options = {}) {
  const env = {
    ...process.env,
    FAKE_CLAUDE_MODE: mode,
    FAKE_CLAUDE_DELAY_MS: String(options.delayMs || 100000),
  };
  delete env.CLAUDE_BIN;
  return env;
}

function runFakeClaude(mode, options = {}) {
  const env = fakeClaudeEnv(mode, options);
  const child = spawn(process.execPath, [fakeClaude, "--output-format", "stream-json", "--verbose"], {
    env,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timer = null;
  if (options.killAfterMs) {
    timer = setTimeout(() => child.kill(), options.killAfterMs);
  }
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("fake claude happy mode emits parseable stream-json with success result", async () => {
  const result = await runFakeClaude("happy");
  const parsed = parseNdjson(result.stdout);
  const last = parsed.events.at(-1);

  assert.equal(result.code, 0);
  assert.equal(parsed.malformed.length, 0);
  assert.ok(parsed.events.length >= 3);
  assert.equal(last.type, "result");
  assert.equal(last.is_error, false);
});

test("fake claude error mode exits non-zero and emits error result", async () => {
  const result = await runFakeClaude("error");
  const parsed = parseNdjson(result.stdout);
  const last = parsed.events.at(-1);

  assert.equal(result.code, 1);
  assert.equal(last.type, "result");
  assert.equal(last.is_error, true);
});

test("fake claude malformed mode counts malformed lines without throwing", async () => {
  const result = await runFakeClaude("malformed");
  const parsed = parseNdjson(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.malformed.length, 2);
});

test("fake claude timeout mode can be killed before result", async () => {
  const result = await runFakeClaude("timeout", { delayMs: 100000, killAfterMs: 50 });
  const parsed = parseNdjson(result.stdout);

  assert.notEqual(result.signal, null);
  assert.equal(parsed.events.some((event) => event.type === "result"), false);
});

test("fake claude control_request mode emits minimal opaque tool request", async () => {
  const result = await runFakeClaude("control_request");
  const parsed = parseNdjson(result.stdout);
  const request = parsed.events.find((event) => event.type === "control_request");

  assert.equal(result.code, 0);
  assert.equal(request.request_id, "r1");
  assert.deepEqual(request.tool, { name: "Read", args: { file_path: "/tmp/x" } });
});

test("claude stage 0 fake process env does not inherit a real claude binary", () => {
  const original = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = "real-claude-should-not-be-used";
  try {
    const env = fakeClaudeEnv("happy");
    assert.equal(env.CLAUDE_BIN, undefined);
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_BIN;
    } else {
      process.env.CLAUDE_BIN = original;
    }
  }
});
