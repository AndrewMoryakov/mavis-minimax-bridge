#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudePrompt } from "../lib/claude-code.mjs";
import { normalizeConfig } from "../lib/config-core.mjs";
import { readJson, stableStringify } from "../lib/json.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function usage() {
  return [
    "Usage: node ./scripts/check-claude.mjs --yes [--out claude-smoke-success.local.json]",
    "",
    "Runs a tiny live Claude Code smoke check through the bridge adapter.",
    "This can spend Anthropic/Claude tokens, so --yes is required.",
  ].join("\n");
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

if (!args.includes("--yes")) {
  console.error(usage());
  console.error("\nRefusing to run live Claude smoke check without --yes.");
  process.exit(2);
}

const configPath = path.join(repoRoot, "config.json");
const config = normalizeConfig(readJson(configPath, {}));
const startedAt = new Date().toISOString();
const result = await runClaudePrompt({
  prompt: "Reply with OK only.",
  cwd: repoRoot,
  config: {
    ...config,
    claudeMaxTurns: 1,
    claudeRunnerTimeoutMs: Math.min(config.claudeRunnerTimeoutMs || 120000, 120000),
  },
});

const report = {
  event: "claude-smoke",
  ok: Boolean(result.ok && result.answer.trim() === "OK"),
  startedAt,
  finishedAt: new Date().toISOString(),
  provider: "anthropic",
  model: result.model,
  configuredModel: config.claudeModel,
  configuredCli: config.claudeCli,
  answer: result.answer.trim(),
  exitCode: result.exitCode,
  resultSubtype: result.resultSubtype,
  isError: result.isError,
  timedOut: result.timedOut,
  costUsd: result.costUsd,
  usage: result.usage,
  warnings: result.diagnostics?.warnings || [],
};

const outPath = argValue("--out");
if (outPath) {
  const resolved = path.resolve(repoRoot, outPath);
  if (!resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`--out must stay inside repository root: ${outPath}`);
  }
  fs.writeFileSync(resolved, stableStringify(report), "utf8");
}

console.log(stableStringify(report));
process.exit(report.ok ? 0 : 1);
