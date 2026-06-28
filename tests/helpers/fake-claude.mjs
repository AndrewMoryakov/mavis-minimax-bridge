#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "..", "fixtures", "claude");
const mode = process.env.FAKE_CLAUDE_MODE || "happy";
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS || 100000);

function writeFixture(name) {
  process.stdout.write(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
  if (!process.stdout.writableEnded) process.stdout.write("\n");
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
  });
}

if (mode === "happy") {
  writeFixture("stream-json.happy.ndjson");
  process.exit(0);
}

if (mode === "error") {
  writeFixture("stream-json.error.ndjson");
  process.exit(1);
}

if (mode === "malformed") {
  writeFixture("stream-json.malformed.ndjson");
  process.exit(0);
}

if (mode === "control_request") {
  writeJson({ type: "system", subtype: "init", session_id: "claude-fixture-control" });
  writeJson({
    type: "control_request",
    request_id: "r1",
    tool: { name: "Read", args: { file_path: "/tmp/x" } },
  });
  writeJson({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    total_cost_usd: 0,
    session_id: "claude-fixture-control",
  });
  process.exit(0);
}

if (mode === "stdin_echo") {
  const input = await readStdin();
  let parsed = null;
  try {
    parsed = JSON.parse(input);
  } catch (_) {
    process.stderr.write("invalid stdin json\n");
    process.exit(3);
  }
  writeJson({ type: "system", subtype: "init", session_id: "claude-fixture-stdin", model: "fake" });
  writeJson({
    type: "assistant",
    message: { content: [{ type: "text", text: parsed?.message?.content?.[0]?.text || "" }] },
  });
  writeJson({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0,
    num_turns: 1,
    session_id: "claude-fixture-stdin",
  });
  process.exit(0);
}

if (mode === "stderr_secret") {
  process.stderr.write("\u001b[31mAuthorization: Bearer sk-secret-value API_TOKEN=abc123\u001b[0m\n");
  writeJson({ type: "system", subtype: "init", session_id: "claude-fixture-secret", model: "fake" });
  writeJson({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1 });
  process.exit(0);
}

if (mode === "timeout") {
  writeJson({ type: "system", subtype: "init", session_id: "claude-fixture-timeout" });
  setTimeout(() => {}, Number.isFinite(delayMs) ? delayMs : 100000);
} else {
  process.stderr.write(`unknown FAKE_CLAUDE_MODE: ${mode}\n`);
  process.exit(2);
}
