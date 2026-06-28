import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeArgs,
  classifyClaudePath,
  defaultClaudeCli,
  parseClaudeStreamJson,
  redactClaudeEnv,
  redactClaudeText,
  resolveClaudeCli,
  runClaudePrompt,
} from "../lib/claude-code.mjs";

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

function mockFs(existing = new Set()) {
  return {
    lstatSync(filePath) {
      if (!existing.has(filePath)) throw new Error(`missing ${filePath}`);
      return { isSymbolicLink: () => false };
    },
    statSync(filePath) {
      if (!existing.has(filePath)) throw new Error(`missing ${filePath}`);
      return { isFile: () => true, mode: 0o755 };
    },
  };
}

function mockRunner(results) {
  const calls = [];
  const runCommand = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(" ")}`;
    const result = results[key] || results[file];
    if (result instanceof Error) throw result;
    return result || { ok: false, stdout: "", stderr: "", exitCode: 1, timedOut: false, error: null };
  };
  runCommand.calls = calls;
  return runCommand;
}

test("claude path classifier recognizes executable and shell shims", () => {
  assert.equal(defaultClaudeCli("win32"), "claude.cmd");
  assert.equal(defaultClaudeCli("linux"), "claude");
  assert.equal(classifyClaudePath("/bin/claude"), "executable");
  assert.equal(classifyClaudePath("/bin/claude.cmd"), "cmd-shim");
  assert.equal(classifyClaudePath("/bin/claude.bat"), "bat-shim");
});

test("resolveClaudeCli accepts configured path with spaces and .cmd shim", async () => {
  const cli = path.resolve("tmp path", "Claude CLI", "claude.cmd");
  const resolved = await resolveClaudeCli({
    configuredCli: cli,
    fs: mockFs(new Set([cli])),
    runCommand: mockRunner({}),
  });

  assert.equal(resolved.kind, "cmd-shim");
  assert.equal(resolved.available, true);
  assert.equal(resolved.command, cli);
  assert.equal(resolved.source, "config");
});

test("resolveClaudeCli finds a POSIX executable on PATH", async () => {
  const cli = path.resolve("usr", "bin", "claude");
  const runCommand = mockRunner({
    "which claude": { ok: true, stdout: `${cli}\n`, stderr: "", exitCode: 0 },
  });
  const resolved = await resolveClaudeCli({
    platform: "linux",
    fs: mockFs(new Set([cli])),
    runCommand,
  });

  assert.equal(resolved.kind, "executable");
  assert.equal(resolved.available, true);
  assert.equal(resolved.command, cli);
  assert.equal(resolved.source, "path");
  assert.deepEqual(runCommand.calls.map((call) => call.file), ["which"]);
});

test("resolveClaudeCli reports missing default command", async () => {
  const resolved = await resolveClaudeCli({
    platform: "linux",
    fs: mockFs(),
    runCommand: mockRunner({
      "which claude": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    }),
  });

  assert.equal(resolved.kind, "missing");
  assert.equal(resolved.available, false);
  assert.match(resolved.remediation, /Install Claude Code CLI/);
});

test("resolveClaudeCli reports missing configured path", async () => {
  const resolved = await resolveClaudeCli({
    configuredCli: path.resolve("missing", "claude"),
    fs: mockFs(),
    runCommand: mockRunner({}),
  });

  assert.equal(resolved.kind, "missing");
  assert.equal(resolved.available, false);
  assert.equal(resolved.source, "config");
});

test("resolveClaudeCli accepts configured .bat shim", async () => {
  const cli = path.resolve("bin", "claude.bat");
  const resolved = await resolveClaudeCli({
    configuredCli: cli,
    fs: mockFs(new Set([cli])),
    runCommand: mockRunner({}),
  });

  assert.equal(resolved.kind, "bat-shim");
  assert.equal(resolved.available, true);
});

test("resolveClaudeCli detects PowerShell functions as non-spawnable", async () => {
  const runCommand = mockRunner({
    "where claude.cmd": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude.exe": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "powershell.exe": { ok: true, stdout: "Function\n\nfunction claude {}\n", stderr: "", exitCode: 0 },
  });
  const resolved = await resolveClaudeCli({
    platform: "win32",
    fs: mockFs(),
    runCommand,
  });

  assert.equal(resolved.kind, "powershell-function");
  assert.equal(resolved.available, false);
  assert.match(resolved.remediation, /standalone Claude CLI/);
});

test("resolveClaudeCli detects PowerShell cmdlets as non-spawnable after where misses", async () => {
  const runCommand = mockRunner({
    "where claude.cmd": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude.exe": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "powershell.exe": { ok: true, stdout: "Cmdlet\n\nGet-Claude\n", stderr: "", exitCode: 0 },
  });
  const resolved = await resolveClaudeCli({
    platform: "win32",
    fs: mockFs(),
    runCommand,
  });

  assert.equal(resolved.kind, "powershell-function");
  assert.equal(resolved.available, false);
  assert.match(resolved.warning, /PowerShell Cmdlet/);
  assert.deepEqual(runCommand.calls.map((call) => call.file), ["where", "where", "where", "powershell.exe"]);
});

test("resolveClaudeCli resolves PowerShell application source to shim", async () => {
  const cli = path.resolve("Claude", "claude.cmd");
  const runCommand = mockRunner({
    "where claude.cmd": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude.exe": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "powershell.exe": { ok: true, stdout: `Application\n${cli}\n${cli}\n`, stderr: "", exitCode: 0 },
  });
  const resolved = await resolveClaudeCli({
    platform: "win32",
    fs: mockFs(new Set([cli])),
    runCommand,
  });

  assert.equal(resolved.kind, "cmd-shim");
  assert.equal(resolved.available, true);
  assert.equal(resolved.command, cli);
  assert.equal(resolved.source, "powershell");
});

test("resolveClaudeCli turns PowerShell probe failures into error diagnostics", async () => {
  const runCommand = mockRunner({
    "where claude.cmd": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude.exe": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "where claude": { ok: false, stdout: "", stderr: "", exitCode: 1 },
    "powershell.exe": { ok: false, stdout: "", stderr: "timeout", exitCode: null, timedOut: true, error: "timeout" },
  });
  const resolved = await resolveClaudeCli({
    platform: "win32",
    fs: mockFs(),
    runCommand,
  });

  assert.equal(resolved.kind, "error");
  assert.equal(resolved.available, false);
  assert.match(resolved.warning, /PowerShell/);
});

test("buildClaudeArgs returns argv array defaults and optional model budget flags", () => {
  assert.deepEqual(buildClaudeArgs({}), [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "1",
  ]);
  const args = buildClaudeArgs({
    claudeModel: "claude-sonnet-4",
    claudeMaxTurns: 2,
    claudeMaxBudgetUsd: 0.25,
  });
  assert.ok(args.every((arg) => typeof arg === "string"));
  assert.deepEqual(args.slice(-6), ["--max-turns", "2", "--model", "claude-sonnet-4", "--max-budget-usd", "0.25"]);
});

test("parseClaudeStreamJson normalizes happy, error, malformed, and control request streams", async () => {
  const happy = parseClaudeStreamJson((await runFakeClaude("happy")).stdout);
  assert.equal(happy.ok, true);
  assert.equal(happy.sessionId, "claude-fixture-happy");
  assert.equal(happy.model, "claude-sonnet-4");
  assert.match(happy.answer, /Stage 0 can be implemented/);
  assert.equal(happy.costUsd, 0.0123);

  const error = parseClaudeStreamJson((await runFakeClaude("error")).stdout);
  assert.equal(error.ok, false);
  assert.equal(error.isError, true);
  assert.equal(error.resultSubtype, "error_max_turns");

  const malformed = parseClaudeStreamJson((await runFakeClaude("malformed")).stdout);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.diagnostics.malformedLines.length, 2);

  const control = parseClaudeStreamJson((await runFakeClaude("control_request")).stdout);
  assert.equal(control.ok, false);
  assert.equal(control.isError, true);
  assert.equal(control.resultSubtype, "control_request");
  assert.deepEqual(control.diagnostics.controlRequest, { type: "control_request", requestId: "r1", toolName: "Read" });
});

test("redactClaudeText strips ansi and secrets while redactClaudeEnv is key based", () => {
  const redacted = redactClaudeText("\u001b[31mAuthorization: Bearer sk-secret API_TOKEN=abc visible-value\u001b[0m");
  assert.equal(redacted.includes("sk-secret"), false);
  assert.equal(redacted.includes("abc"), false);
  assert.match(redacted, /visible-value/);

  const env = redactClaudeEnv({ API_TOKEN: "abc", NORMAL: "contains TOKEN word but is not a secret key" });
  assert.equal(env.API_TOKEN, "[REDACTED]");
  assert.equal(env.NORMAL, "contains TOKEN word but is not a secret key");
});

function fakeSpawnImpl(mode, options = {}) {
  return (command, args, spawnOptions) => {
    assert.equal(command, "fake-claude");
    assert.ok(args.every((arg) => typeof arg === "string"));
    return spawn(process.execPath, [fakeClaude, ...args], {
      ...spawnOptions,
      env: fakeClaudeEnv(mode, { delayMs: options.delayMs }),
      windowsHide: true,
    });
  };
}

test("runClaudePrompt sends stream-json user envelope and normalizes success", async () => {
  const result = await runClaudePrompt({
    prompt: "hello claude",
    cli: { available: true, command: "fake-claude" },
    config: { claudeMaxTurns: 1, claudeRunnerTimeoutMs: 5000 },
    spawnImpl: fakeSpawnImpl("stdin_echo"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.answer, "hello claude");
  assert.equal(result.sessionId, "claude-fixture-stdin");
  assert.equal(result.exitCode, 0);
});

test("runClaudePrompt returns missing_cli without spawning when cli is unavailable", async () => {
  let spawned = false;
  const result = await runClaudePrompt({
    prompt: "hello",
    cli: { available: false, kind: "missing", warning: "missing" },
    spawnImpl() {
      spawned = true;
      throw new Error("should not spawn");
    },
  });

  assert.equal(spawned, false);
  assert.equal(result.ok, false);
  assert.equal(result.resultSubtype, "missing_cli");
});

test("runClaudePrompt pins non-zero exit, timeout, and stderr redaction shapes", async () => {
  const nonZero = await runClaudePrompt({
    prompt: "hello",
    cli: { available: true, command: "fake-claude" },
    config: { claudeRunnerTimeoutMs: 5000 },
    spawnImpl: fakeSpawnImpl("unknown_mode"),
  });
  assert.equal(nonZero.ok, false);
  assert.equal(nonZero.isError, true);
  assert.equal(nonZero.exitCode, 2);
  assert.equal(nonZero.resultSubtype, "non_zero_exit");
  assert.match(nonZero.diagnostics.stderrSummary, /unknown FAKE_CLAUDE_MODE/);

  const secret = await runClaudePrompt({
    prompt: "hello",
    cli: { available: true, command: "fake-claude" },
    config: { claudeRunnerTimeoutMs: 5000 },
    spawnImpl: fakeSpawnImpl("stderr_secret"),
  });
  assert.equal(secret.ok, true);
  assert.equal(secret.diagnostics.stderrSummary.includes("sk-secret-value"), false);
  assert.equal(secret.diagnostics.stderrSummary.includes("abc123"), false);

  let killed = false;
  const timeout = await runClaudePrompt({
    prompt: "hello",
    cli: { available: true, command: "fake-claude" },
    config: { claudeRunnerTimeoutMs: 30 },
    spawnImpl: fakeSpawnImpl("timeout", { delayMs: 100000 }),
    killImpl(child) {
      killed = true;
      child.kill();
    },
  });
  assert.equal(killed, true);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.resultSubtype, "timeout");
});
