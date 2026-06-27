#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(bridgeDir, "config.json");
const inboxPath = path.join(bridgeDir, "inbox.jsonl");
const outboxPath = path.join(bridgeDir, "outbox.jsonl");
const ledgerPath = path.join(bridgeDir, "ledger.jsonl");
const duetStatePath = path.join(bridgeDir, "duet-state.json");
const duetJournalPath = path.join(bridgeDir, "duet-journal.md");
const duetLockPath = path.join(bridgeDir, "duet.lock");
const duetLockStaleMs = 10 * 60 * 1000;
const duetMaxEntryChars = 20000;
const packageName = "mavis-minimax-bridge";
const sourceIncludeMaxFiles = 80;
const sourceIncludeMaxDirs = 160;
const verifierMaxBytes = 256 * 1024;
const verifierMaxArgs = 256;
const verifierMaxArgBytes = 32 * 1024;
const verifierMaxStreamBytes = 1024 * 1024;
let configLoadError = null;

function defaultConfig() {
  return {
    defaultModel: "minimax/MiniMax-M3",
    mavisDaemonPort: 15321,
    currentMavisSession: null,
    mavisCli: null,
    sessionDirectory: null,
    mvsMaxSendChars: 4000,
    requireProvider: "minimax",
    requireModel: "minimax/MiniMax-M3",
    maxTurns: 3,
    maxWallClockSec: 180,
    maxInputTokens: 200000,
    outputCapTokens: 8192,
    nearOutputCapRatio: 0.9,
    includeOptimizationContext: true,
    tinyCanaryInputEstimateTokens: 12000,
    maxLongPromptChars: 160000,
    maxLongPromptRepeats: 3,
    askSourceContextMode: "auto",
    askMaxSourceContextChars: 24000,
    duetPacketMaxChars: 60000,
    codexCli: process.platform === "win32" ? "codex.cmd" : "codex",
    codexStepTimeoutSec: 180,
    asciiConsole: true,
    denySessions: [],
    env: {
      MAVIS_PROMPT_CACHE_MODE: "enforce",
      MAVIS_CONTEXT_BUDGET_MODE: "enforce",
      MAVIS_CONTEXT_BUDGET_PROFILE: "max",
      MAVIS_PROMPT_CACHE_OPENROUTER: "",
    },
  };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function normalizeConfig(input) {
  const merged = { ...defaultConfig(), ...(input || {}) };
  merged.env = { ...defaultConfig().env, ...(merged.env || {}) };
  merged.denySessions = Array.isArray(merged.denySessions) ? [...new Set(merged.denySessions)] : [];
  validateConfig(merged);
  return merged;
}

function loadInitialConfig() {
  try {
    return normalizeConfig(readJson(configPath, {}));
  } catch (error) {
    configLoadError = error;
    return normalizeConfig({});
  }
}

const config = loadInitialConfig();

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeConfig(next, reason = "config-write") {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const merged = normalizeConfig(next);
  fs.writeFileSync(configPath, stableStringify(merged), "utf8");
  Object.keys(config).forEach((key) => delete config[key]);
  Object.assign(config, merged);
  appendJsonl(ledgerPath, { event: "config-updated", reason, changedKeys: Object.keys(next).sort() });
  return merged;
}

function now() {
  return new Date().toISOString();
}

function appendJsonl(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ ts: now(), ...event })}\n`, "utf8");
}

function escapeNonAscii(text) {
  return text.replace(/[^\x00-\x7F]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function printJson(value) {
  const json = JSON.stringify(value, null, 2);
  console.log(config.asciiConsole === false ? json : escapeNonAscii(json));
}

function usage() {
  console.log(`Usage:
  node .\\bridge.mjs doctor
  node .\\bridge.mjs status
  node .\\bridge.mjs state
  node .\\bridge.mjs config show
  node .\\bridge.mjs config set --key <name|env.NAME> --value <json|string>
  node .\\bridge.mjs mode list
  node .\\bridge.mjs mode set [--profile max|medium|free] [--prompt-cache enforce|observe|off] [--context-budget enforce|observe|off]
  node .\\bridge.mjs session show|set|clear [--session <mvs-id>]
  node .\\bridge.mjs deny-session list|add|remove --session <id>
  node .\\bridge.mjs token-stats [--session <mvs-id>] [--ledger] [--lines <n>]
  node .\\bridge.mjs audit [--session <mvs-id>] [--lines <n>] [--plugin-lines <n>]
  node .\\bridge.mjs canary-estimate [--long-prompt <file>] [--repeat-long <n>]
  node .\\bridge.mjs canary --yes [--port <port>]
  node .\\bridge.mjs optimize-check [--yes] [--session <mvs-id>] [--port <port>] [--skip-canary] [--long-prompt <file>] [--repeat-long <n>]
  node .\\bridge.mjs ask --yes --mode review-only --task <file> [--task <followup-file> ...] [--include <path> ...] [--source-context auto|off] [--dry-run] [--port <port>]
  node .\\bridge.mjs mvs-status [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-peers [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-messages [--session <mvs-id>] [--limit <n>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-send --task <file> --yes [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-send --content <text> --allow-inline-content --yes [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs duet init --goal <file> [--baton codex|minimax] [--max-iterations <n>] [--force] [--raw]
  node .\\bridge.mjs duet show [--raw]
  node .\\bridge.mjs duet next [--agent codex|minimax] [--raw]
  node .\\bridge.mjs duet packet export --agent minimax [--format json|markdown] [--out <file>] [--raw] [--max-packet-chars <n>]
  node .\\bridge.mjs duet step --agent codex|minimax --dry-run|--yes [--raw] [--max-packet-chars <n>] [--port <port>]
  node .\\bridge.mjs duet loop --dry-run [--max-rounds <n>] [--max-codex-steps <n>] [--max-minimax-steps <n>] [--max-tokens <n>] [--verifier <file>] [-- <verifier-args>...]
  node .\\bridge.mjs duet transcript export [--format json|markdown] [--out <file>] [--raw] [--include-ledger]
  node .\\bridge.mjs duet verify --verifier <file.js|file.mjs|file.cjs> [--timeout-sec <n>] [--raw] [--record --agent codex|minimax] [-- <verifier-args>...]
  node .\\bridge.mjs duet pass --from codex|minimax [--to codex|minimax] --handoff <file> [--status running|done|human_escalation] [--force] [--raw]
  node .\\bridge.mjs duet note --agent codex|minimax --note <file> [--raw]
  node .\\bridge.mjs tail [--lines <n>] [--raw]
  node .\\bridge.mjs stop`);
}

class WorkspaceGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkspaceGuardError";
    this.skipLedger = true;
    this.details = details;
  }
}

function realpathOrResolve(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function comparablePath(inputPath) {
  const normalized = path.normalize(realpathOrResolve(inputPath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function gitRootInfo(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return {
      available: false,
      cwd,
      root: null,
      matchesExpectedRoot: false,
      error: String(result.stderr || result.stdout || "").trim() || "git root not available",
    };
  }
  const root = realpathOrResolve(String(result.stdout || "").trim());
  return {
    available: true,
    cwd,
    root,
    matchesExpectedRoot: pathsEqual(root, bridgeDir),
  };
}

function sentinelInfo(relativePath, options = {}) {
  const fullPath = path.join(bridgeDir, relativePath);
  const exists = fs.existsSync(fullPath);
  const info = {
    path: fullPath,
    relativePath,
    exists,
    required: Boolean(options.required),
  };
  if (exists && options.packageName) {
    const data = readJson(fullPath, null);
    info.packageName = data?.name || null;
    info.matchesPackageName = info.packageName === options.packageName;
  }
  return info;
}

function doctorReport() {
  const expectedRepoRoot = realpathOrResolve(bridgeDir);
  const currentCwd = realpathOrResolve(process.cwd());
  const cwdMatchesExpectedRoot = pathsEqual(currentCwd, expectedRepoRoot);
  const sentinels = [
    sentinelInfo("bridge.mjs", { required: true }),
    sentinelInfo("package.json", { packageName, required: false }),
    sentinelInfo(path.join("docs", "COMMANDS.md"), { required: false }),
    sentinelInfo(path.join("examples", "duet-tetris-browser"), { required: false }),
  ];
  const missingRequiredSentinels = sentinels.filter((item) => item.required && !item.exists);
  const missingOptionalSentinels = sentinels.filter((item) => !item.required && !item.exists);
  const packageSentinel = sentinels.find((item) => item.relativePath === "package.json");
  const packageNameMismatch = Boolean(packageSentinel?.exists && packageSentinel.matchesPackageName === false);
  const git = {
    bridgeDir: gitRootInfo(bridgeDir),
    currentCwd: gitRootInfo(process.cwd()),
  };

  const warnings = [];
  if (!cwdMatchesExpectedRoot) warnings.push("current working directory is not the bridge root");
  if (missingOptionalSentinels.length > 0) {
    warnings.push(`optional sentinels missing: ${missingOptionalSentinels.map((item) => item.relativePath).join(", ")}`);
  }
  if (packageNameMismatch) warnings.push(`package.json name is not ${packageName}`);
  if (configLoadError) warnings.push(`config load failed: ${configLoadError.message}`);
  if (git.bridgeDir.available && !git.bridgeDir.matchesExpectedRoot) {
    warnings.push("bridge directory git root does not match bridge root");
  }

  const verdict = !cwdMatchesExpectedRoot || missingRequiredSentinels.length > 0 || packageNameMismatch || configLoadError
    ? "fail"
    : warnings.length > 0
      ? "warn"
      : "ok";
  const nextCommand = cwdMatchesExpectedRoot
    ? "Run the requested bridge command from this directory."
    : `Set-Location -LiteralPath ${JSON.stringify(expectedRepoRoot)}`;

  return {
    event: "doctor",
    expectedRepoRoot,
    currentCwd,
    cwdMatchesExpectedRoot,
    sentinels,
    git,
    config: {
      path: configPath,
      loaded: !configLoadError,
      error: configLoadError ? configLoadError.message : null,
    },
    warnings,
    verdict,
    nextCommand,
  };
}

function doctorCommand() {
  printJson(doctorReport());
}

function isHelpArgs(args) {
  const [subcommand] = args;
  return !subcommand || subcommand === "help" || subcommand === "--help";
}

function commandRequiresWorkspaceRoot(command, args) {
  if (command === "duet") return !isHelpArgs(args);
  if (command === "ask") return true;
  if (command === "mvs-send") return args.includes("--task");
  if (["canary", "canary-estimate", "optimize-check"].includes(command)) return args.includes("--long-prompt");
  return false;
}

function ensureWorkspaceRoot(command, args) {
  if (!commandRequiresWorkspaceRoot(command, args)) return;
  if (pathsEqual(process.cwd(), bridgeDir)) return;
  const report = doctorReport();
  throw new WorkspaceGuardError(
    `workspace guard blocked ${command}: run from bridge root ${report.expectedRepoRoot}`,
    report,
  );
}

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function findServeProcesses() {
  const ps = `
$items = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'opencode.exe' -and $_.CommandLine -match 'serve --port' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, 'serve\\s+--port\\s+(\\d+)')
    if ($m.Success) {
      $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.ParentProcessId) -ErrorAction SilentlyContinue
      [pscustomobject]@{
        pid = $_.ProcessId
        parentPid = $_.ParentProcessId
        parentName = if ($parent) { $parent.Name } else { $null }
        port = [int]$m.Groups[1].Value
        hasCommandLine = [bool]$_.CommandLine
      }
    }
  }
$items | ConvertTo-Json -Depth 4
`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = readJsonFromString(result.stdout.trim(), []);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function readJsonFromString(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function runJson(command, commandArgs, options = {}) {
  const spawn = command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".bat")
    ? {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", [quoteCmd(command), ...commandArgs.map(quoteCmd)].join(" ")],
      }
    : { command, args: commandArgs };
  const result = spawnSync(spawn.command, spawn.args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").trim().slice(0, 1000)}`);
  }
  const parsed = readJsonFromString(result.stdout, null);
  if (!parsed) throw new Error(`${command} ${commandArgs.join(" ")} did not return JSON`);
  return parsed;
}

function quoteCmd(value) {
  const text = String(value);
  return /[\s"&<>|^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`expected JSON from ${url}, got ${body ? body.slice(0, 500) : "empty response"}: ${error.message}`);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutSec = 60) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    return await fetchJson(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`timeout after ${timeoutSec}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readLongPrompt(args) {
  const longPromptPath = argValue(args, "--long-prompt");
  if (!longPromptPath) return null;
  const resolved = path.resolve(longPromptPath);
  const text = fs.readFileSync(resolved, "utf8");
  const maxChars = Number(config.maxLongPromptChars || 160000);
  if (text.length > maxChars) {
    throw new Error(`long prompt too large: ${text.length} chars > ${maxChars}`);
  }
  return { path: resolved, text, chars: text.length };
}

function requireSpendingApproval(args, command) {
  if (!args.includes("--yes")) {
    throw new Error(`${command} requires --yes because it can trigger a model turn`);
  }
}

function isDeniedSession(sessionID) {
  return Boolean(sessionID && config.denySessions?.includes(sessionID));
}

function assertNotDeniedSession(sessionID, action) {
  if (isDeniedSession(sessionID)) {
    throw new Error(`refusing ${action} for denied session ${sessionID}`);
  }
}

function assertMvsSessionID(sessionID, action = "session") {
  if (!sessionID || !/^mvs_[A-Za-z0-9_-]+$/.test(String(sessionID))) {
    throw new Error(`${action} requires --session mvs_<id>`);
  }
}

function estimateInputTokensForText(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 4);
}

function sha256(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function assertTaskBudget(tasks) {
  const maxTurns = Number(config.maxTurns || 3);
  if (tasks.length > maxTurns) {
    throw new Error(`too many task turns: ${tasks.length} > maxTurns=${maxTurns}`);
  }
  const maxChars = Number(config.maxLongPromptChars || 160000);
  for (const task of tasks) {
    if (task.text.length > maxChars) {
      throw new Error(`task file too large: ${task.text.length} chars > maxLongPromptChars=${maxChars}: ${task.taskPath}`);
    }
  }
  const prompts = tasks.map((task) => addOptimizationContext(task.text, { role: "main" }));
  const estimatedInputTokens = prompts.reduce((sum, prompt) => sum + estimateInputTokensForText(prompt), 0);
  const maxInputTokens = Number(config.maxInputTokens || 200000);
  if (estimatedInputTokens > maxInputTokens) {
    throw new Error(`estimated task input too large: ${estimatedInputTokens} tokens > maxInputTokens=${maxInputTokens}`);
  }
  return {
    estimatedInputTokens,
    maxInputTokens,
    maxTurns,
    maxChars,
  };
}

function runGit(args, cwd = bridgeDir) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
}

function safeGitText(result) {
  return `${result.stdout || ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.trim();
}

function appendBounded(parts, title, text, budget) {
  if (!text || budget.remaining <= 0) return;
  const blockPrefix = `\n\n## ${title}\n\n`;
  const available = budget.remaining - blockPrefix.length;
  if (available <= 0) {
    budget.truncated = true;
    return;
  }
  let body = text;
  if (body.length > available) {
    body = `${body.slice(0, Math.max(0, available - 80))}\n\n[truncated: source context character budget reached]`;
    budget.truncated = true;
  }
  parts.push(`${blockPrefix}${body}`);
  budget.remaining -= blockPrefix.length + body.length;
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return !sample.includes(0);
}

function listUntrackedPaths(repoRoot) {
  const result = runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout || "")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function readUntrackedSnippet(repoRoot, relativePath, perFileLimit) {
  const fullPath = path.resolve(repoRoot, relativePath);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
  if (!fullPath.startsWith(rootWithSep)) {
    return `### ${relativePath}\n\n[skipped: path escapes repository root]`;
  }
  if (!fs.existsSync(fullPath)) {
    return `### ${relativePath}\n\n[skipped: not a regular file]`;
  }
  const stats = fs.statSync(fullPath);
  if (!stats.isFile()) {
    return `### ${relativePath}\n\n[skipped: not a regular file]`;
  }

  const maxBytes = Math.max(4096, perFileLimit * 4);
  const bytesToRead = Math.min(stats.size, maxBytes);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let bytesRead = 0;
  const fd = fs.openSync(fullPath, "r");
  try {
    bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(fd);
  }
  const prefix = buffer.subarray(0, bytesRead);
  if (!isProbablyText(prefix)) {
    return `### ${relativePath}\n\n[skipped: binary-looking file, ${stats.size} bytes]`;
  }
  const text = prefix.toString("utf8");
  const truncated = stats.size > bytesRead || text.length > perFileLimit;
  const body = truncated ? `${text.slice(0, perFileLimit)}\n\n[truncated: file is ${stats.size} bytes]` : text;
  return `### ${relativePath}\n\n\`\`\`\n${body}\n\`\`\``;
}

function isPathInsideRoot(rootPath, candidatePath) {
  const root = comparablePath(rootPath);
  const candidate = comparablePath(candidatePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(rootWithSep);
}

function relativeBridgePath(filePath) {
  return path.relative(bridgeDir, filePath).replace(/\\/g, "/");
}

function shouldSkipSourceContextPath(relativePath, taskPathSet = new Set()) {
  const normalized = relativePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) return true;
  if (taskPathSet.has(comparablePath(path.join(bridgeDir, normalized)))) return true;
  if (lower === ".git" || lower.startsWith(".git/")) return true;
  if (lower === "node_modules" || lower.startsWith("node_modules/")) return true;
  if (lower.startsWith("live-smoke-")) return true;
  if (base === ".env" || lower.endsWith("/.env")) return true;
  if (lower.endsWith(".local.md") || lower.includes(".local.")) return true;
  if ([
    "config.json",
    "ledger.jsonl",
    "inbox.jsonl",
    "outbox.jsonl",
    "duet-state.json",
    "duet-journal.md",
    "duet.lock",
  ].includes(base)) return true;
  if (/^duet-(state|journal)\.json\..*\.tmp$/i.test(base)) return true;
  if (lower === "examples/duet-simple-orders/answer.json") return true;
  if ([
    "examples/duet-tetris-browser/index.html",
    "examples/duet-tetris-browser/styles.css",
    "examples/duet-tetris-browser/game.js",
  ].includes(lower)) return true;
  return false;
}

function readSourceSnippet(fullPath, displayPath, perFileLimit) {
  if (!fs.existsSync(fullPath)) {
    return { text: `### ${displayPath}\n\n[skipped: not found]`, included: false, skipped: true };
  }
  const stats = fs.statSync(fullPath);
  if (!stats.isFile()) {
    return { text: `### ${displayPath}\n\n[skipped: not a regular file]`, included: false, skipped: true };
  }

  const maxBytes = Math.max(4096, perFileLimit * 4);
  const bytesToRead = Math.min(stats.size, maxBytes);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let bytesRead = 0;
  const fd = fs.openSync(fullPath, "r");
  try {
    bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(fd);
  }
  const prefix = buffer.subarray(0, bytesRead);
  if (!isProbablyText(prefix)) {
    return {
      text: `### ${displayPath}\n\n[skipped: binary-looking file, ${stats.size} bytes]`,
      included: false,
      skipped: true,
    };
  }
  const text = prefix.toString("utf8");
  const truncated = stats.size > bytesRead || text.length > perFileLimit;
  const body = truncated ? `${text.slice(0, perFileLimit)}\n\n[truncated: file is ${stats.size} bytes]` : text;
  return {
    text: `### ${displayPath}\n\n\`\`\`\n${body}\n\`\`\``,
    included: true,
    skipped: false,
  };
}

function includedSourceFiles(includePaths, taskPaths = []) {
  const taskPathSet = new Set(taskPaths.map((taskPath) => comparablePath(taskPath)));
  const files = [];
  const skipped = [];
  const seen = new Set();
  const visitedDirectories = new Set();
  let fileLimitReached = false;
  let dirLimitReached = false;

  const addFile = (realPath) => {
    const relative = relativeBridgePath(realPath);
    if (shouldSkipSourceContextPath(relative, taskPathSet)) {
      skipped.push({ path: relative, reason: "excluded" });
      return;
    }
    const key = comparablePath(realPath);
    if (seen.has(key)) return;
    if (files.length >= sourceIncludeMaxFiles) {
      fileLimitReached = true;
      skipped.push({ path: relative, reason: `file limit reached (${sourceIncludeMaxFiles})` });
      return;
    }
    seen.add(key);
    files.push({ path: realPath, relativePath: relative });
  };

  const visit = (realPath) => {
    if (fileLimitReached || dirLimitReached) return;
    if (!isPathInsideRoot(bridgeDir, realPath)) {
      throw new Error(`--include path escapes bridge root: ${realPath}`);
    }
    const stats = fs.statSync(realPath);
    if (stats.isFile()) {
      addFile(realPath);
      return;
    }
    if (!stats.isDirectory()) {
      skipped.push({ path: relativeBridgePath(realPath), reason: "not a regular file" });
      return;
    }
    const dirKey = comparablePath(realPath);
    if (visitedDirectories.has(dirKey)) {
      skipped.push({ path: relativeBridgePath(realPath), reason: "already visited" });
      return;
    }
    if (visitedDirectories.size >= sourceIncludeMaxDirs) {
      dirLimitReached = true;
      skipped.push({ path: relativeBridgePath(realPath), reason: `directory limit reached (${sourceIncludeMaxDirs})` });
      return;
    }
    visitedDirectories.add(dirKey);
    const entries = fs.readdirSync(realPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (fileLimitReached || dirLimitReached) break;
      const child = path.join(realPath, entry.name);
      const childRelative = relativeBridgePath(child);
      if (shouldSkipSourceContextPath(childRelative, taskPathSet)) {
        skipped.push({ path: childRelative, reason: "excluded" });
        continue;
      }
      const childReal = realpathOrResolve(child);
      if (!isPathInsideRoot(bridgeDir, childReal)) {
        throw new Error(`--include path escapes bridge root: ${child}`);
      }
      const childStats = fs.statSync(childReal);
      if (childStats.isDirectory()) {
        visit(childReal);
      } else if (childStats.isFile()) {
        addFile(childReal);
      } else {
        skipped.push({ path: childRelative, reason: "not a regular file" });
      }
    }
  };

  for (const includePath of includePaths) {
    const requested = path.resolve(process.cwd(), includePath);
    if (!fs.existsSync(requested)) {
      throw new Error(`--include path not found: ${requested}`);
    }
    const realPath = realpathOrResolve(requested);
    if (!isPathInsideRoot(bridgeDir, realPath)) {
      throw new Error(`--include path escapes bridge root: ${requested}`);
    }
    visit(realPath);
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return {
    files,
    skipped,
    limits: {
      maxFiles: sourceIncludeMaxFiles,
      maxDirs: sourceIncludeMaxDirs,
      fileLimitReached,
      dirLimitReached,
    },
  };
}

function buildAskSourceContext(args, taskPaths = []) {
  const mode = argValue(args, "--source-context", config.askSourceContextMode || "auto");
  if (!["auto", "off"].includes(mode)) {
    throw new Error("--source-context must be auto or off");
  }
  const includePaths = argValues(args, "--include");
  if (mode === "off" && includePaths.length > 0) {
    throw new Error("--include cannot be used with --source-context off");
  }
  const maxChars = Number(argValue(args, "--source-context-chars", String(config.askMaxSourceContextChars ?? 24000)));
  if (!Number.isFinite(maxChars) || maxChars < 0 || maxChars > 200000) {
    throw new Error("--source-context-chars must be a number from 0 to 200000");
  }
  if (mode === "off" || maxChars === 0) {
    return { mode, included: false, reason: mode === "off" ? "disabled" : "zero budget", chars: 0, truncated: false, text: "" };
  }

  const includeResult = includePaths.length > 0
    ? includedSourceFiles(includePaths, taskPaths)
    : {
        files: [],
        skipped: [],
        limits: {
          maxFiles: sourceIncludeMaxFiles,
          maxDirs: sourceIncludeMaxDirs,
          fileLimitReached: false,
          dirLimitReached: false,
        },
      };
  const rootResult = runGit(["rev-parse", "--show-toplevel"]);
  const hasGitRoot = rootResult.status === 0;
  const repoRoot = hasGitRoot ? path.resolve(String(rootResult.stdout || "").trim()) : null;
  const statusResult = hasGitRoot ? runGit(["status", "--porcelain=v1", "--untracked-files=all"], repoRoot) : null;
  const statusText = statusResult ? safeGitText(statusResult) : "";
  const hasDirtyWorktree = Boolean(statusResult && statusResult.status === 0 && statusText.trim());
  if (!hasDirtyWorktree && includeResult.files.length === 0 && includeResult.skipped.length === 0) {
    return {
      mode,
      included: false,
      reason: !hasGitRoot ? "not a git repository" : statusResult.status !== 0 ? "git status failed" : "clean worktree",
      chars: 0,
      truncated: false,
      text: "",
      repoRoot,
      includeCount: 0,
      includeSkippedCount: 0,
    };
  }

  const parts = [
    "MiniMax source visibility context.",
    "The reviewer may not have direct access to this local worktree; use this bounded context as the source of truth for uncommitted changes.",
  ];
  const wrapperReserve = 120;
  const budget = { remaining: Math.max(0, maxChars - parts.join("\n").length - wrapperReserve), truncated: false };

  if (hasDirtyWorktree) {
    appendBounded(parts, "git status --short", statusText, budget);
    appendBounded(parts, "git diff --stat", safeGitText(runGit(["diff", "--stat"], repoRoot)), budget);
  }

  const excluded = new Set(taskPaths.map((taskPath) => comparablePath(taskPath)));
  const untracked = hasDirtyWorktree ? listUntrackedPaths(repoRoot)
    .filter((relativePath) => !excluded.has(comparablePath(path.resolve(repoRoot, relativePath)))) : [];
  if (hasDirtyWorktree && untracked.length > 0) {
    const perFileLimit = Math.max(1200, Math.min(6000, Math.floor(maxChars / Math.max(2, untracked.length))));
    const snippets = untracked.map((relativePath) => readUntrackedSnippet(repoRoot, relativePath, perFileLimit)).join("\n\n");
    appendBounded(parts, "untracked text file snippets", snippets, budget);
  }

  if (includeResult.files.length > 0) {
    const perFileLimit = Math.max(1200, Math.min(6000, Math.floor(maxChars / Math.max(2, includeResult.files.length))));
    const snippets = includeResult.files.map((file) => readSourceSnippet(file.path, file.relativePath, perFileLimit));
    const includedCount = snippets.filter((snippet) => snippet.included).length;
    const binarySkippedCount = snippets.filter((snippet) => snippet.skipped).length;
    appendBounded(parts, "explicit include text file snippets", snippets.map((snippet) => snippet.text).join("\n\n"), budget);
    includeResult.includedCount = includedCount;
    includeResult.binarySkippedCount = binarySkippedCount;
  } else {
    includeResult.includedCount = 0;
    includeResult.binarySkippedCount = 0;
  }

  if (includeResult.skipped.length > 0) {
    const skippedText = includeResult.skipped
      .map((item) => `- ${item.path}: ${item.reason}`)
      .join("\n");
    appendBounded(parts, "explicit include skipped paths", skippedText, budget);
  }

  if (hasDirtyWorktree) {
    appendBounded(parts, "git diff --cached", safeGitText(runGit(["diff", "--cached", "--no-ext-diff", "--"], repoRoot)), budget);
    appendBounded(parts, "git diff", safeGitText(runGit(["diff", "--no-ext-diff", "--"], repoRoot)), budget);
  }

  const text = `<source_context mode="${mode}" chars="${maxChars}" truncated="${budget.truncated}">\n${parts.join("\n")}\n</source_context>`;
  const reason = hasDirtyWorktree && includePaths.length > 0
    ? "dirty worktree and explicit include"
    : hasDirtyWorktree
      ? "dirty worktree"
      : "explicit include";
  return {
    mode,
    included: true,
    reason,
    repoRoot,
    chars: text.length,
    maxChars,
    truncated: budget.truncated,
    untrackedCount: untracked.length,
    includeCount: includeResult.includedCount || 0,
    includeSkippedCount: (includeResult.skipped.length || 0) + (includeResult.binarySkippedCount || 0),
    includePaths: includePaths.map((includePath) => path.resolve(process.cwd(), includePath)),
    includeLimits: includeResult.limits,
    text,
  };
}

function canaryPrompts(args) {
  const prompts = [
    { label: "ready", text: "Reply exactly: READY" },
    { label: "pong", text: "Reply exactly: PONG" },
  ];
  const longPrompt = readLongPrompt(args);
  if (longPrompt) {
    const maxRepeats = Number(config.maxLongPromptRepeats || 3);
    const repeatLong = Math.max(1, Math.min(maxRepeats, Number(argValue(args, "--repeat-long", "1")) || 1));
    for (let i = 1; i <= repeatLong; i += 1) {
      prompts.push({
        label: repeatLong === 1 ? "long" : `long-${i}`,
        path: longPrompt.path,
        chars: longPrompt.chars,
        text: `Reply exactly: LONGOK${i}\n\n${longPrompt.text}`,
      });
    }
  }
  return prompts;
}

function canaryEstimate(args) {
  const prompts = canaryPrompts(args);
  const promptChars = prompts.reduce((sum, prompt) => {
    const text = addOptimizationContext(prompt.text, { role: "main" });
    return sum + Buffer.byteLength(text, "utf8");
  }, 0);
  const tinyInputEstimateTokens = Number(config.tinyCanaryInputEstimateTokens || 12000);
  const extraPromptTokens = Math.ceil(Math.max(0, promptChars - 40) / 4);
  const longPrompt = prompts.find((prompt) => prompt.path);
  return {
    event: "canary-estimate",
    turns: prompts.length,
    promptChars,
    estimatedInputTokens: tinyInputEstimateTokens + extraPromptTokens,
    tinyInputEstimateTokens,
    maxInputTokens: Number(config.maxInputTokens || 200000),
    longPrompt: longPrompt ? {
      path: longPrompt.path,
      chars: longPrompt.chars,
      repeats: prompts.filter((prompt) => prompt.path).length,
    } : null,
    note: "Estimate only. It includes a conservative tiny-canary overhead and does not send a model request.",
  };
}

function summarizeConfig(port, runtimeConfig) {
  return {
    port,
    model: runtimeConfig.model || null,
    small_model: runtimeConfig.small_model || null,
    plan: runtimeConfig.agent?.plan?.model || null,
    build: runtimeConfig.agent?.build?.model || null,
    general: runtimeConfig.agent?.general?.model || null,
    explore: runtimeConfig.agent?.explore?.model || null,
  };
}

async function liveServers() {
  const processes = findServeProcesses();
  const servers = [];
  for (const proc of processes) {
    try {
      const runtimeConfig = await fetchJson(`http://127.0.0.1:${proc.port}/config`);
      servers.push({ ...proc, config: summarizeConfig(proc.port, runtimeConfig) });
    } catch (error) {
      servers.push({ ...proc, error: error.message });
    }
  }
  return servers;
}

function assertUsableServer(server) {
  if (!server || server.error) {
    throw new Error(`no usable opencode serve found${server?.error ? `: ${server.error}` : ""}`);
  }
  if (server.config?.model !== requiredModel()) {
    throw new Error(`main model mismatch: expected ${requiredModel()}, got ${server.config?.model}`);
  }
  const requiredProvider = config.requireProvider || providerFromModel(requiredModel());
  const actualProvider = providerFromModel(server.config?.model);
  if (requiredProvider && actualProvider !== requiredProvider) {
    throw new Error(`main provider mismatch: expected ${requiredProvider}, got ${actualProvider || "unknown"}`);
  }
}

function requiredModel() {
  return config.requireModel || config.defaultModel || "minimax/MiniMax-M3";
}

async function selectServer(args) {
  const requestedPort = argValue(args, "--port");
  const servers = await liveServers();
  const selected = requestedPort
    ? servers.find((s) => String(s.port) === String(requestedPort))
    : servers.find((s) => s.parentName === "MiniMax Code.exe" && s.config?.model === requiredModel()) ||
      servers.find((s) => s.config?.model === requiredModel()) ||
      servers[0];
  assertUsableServer(selected);
  return selected;
}

function modelSpec(model = null) {
  const [providerID, ...rest] = String(model || requiredModel()).split("/");
  return { providerID, modelID: rest.join("/") };
}

function sessionDirectory() {
  return config.sessionDirectory || path.join(os.homedir(), ".minimax", "agents", "mavis", "workspace");
}

function sessionQuery() {
  return `directory=${encodeURIComponent(sessionDirectory())}`;
}

function messageUrl(port, sessionID) {
  return `http://127.0.0.1:${port}/session/${sessionID}/message?${sessionQuery()}`;
}

function mvsDaemonPort(args) {
  return Number(argValue(args, "--daemon-port", config.mavisDaemonPort || 15321));
}

function mvsSession(args) {
  const sessionID = argValue(args, "--session", config.currentMavisSession || null);
  if (!sessionID) throw new Error("--session is required unless config.currentMavisSession is set");
  assertMvsSessionID(sessionID);
  assertNotDeniedSession(sessionID, "session access");
  return sessionID;
}

function mvsBase(port) {
  return `http://127.0.0.1:${port}/mavis/api`;
}

async function fetchMavisJson(pathname, options = {}, timeoutSec = 60) {
  const port = options.port || config.mavisDaemonPort || 15321;
  return await fetchJsonWithTimeout(`${mvsBase(port)}${pathname}`, options.fetchOptions || {}, timeoutSec);
}

async function verifyMavisSession(port, sessionID, options = {}) {
  assertMvsSessionID(sessionID);
  assertNotDeniedSession(sessionID, options.action || "session access");
  const statusID = options.statusID || sessionID;
  const status = await fetchMavisJson(`/session/${encodeURIComponent(statusID)}`, { port }, 15);
  const resolvedSession = status?.session?.sessionId || null;
  if (resolvedSession && resolvedSession !== sessionID && !options.allowMismatch) {
    throw new Error(`session mismatch: requested ${sessionID}, resolved ${resolvedSession}`);
  }
  return { statusID, status, resolvedSession };
}

async function createSession(port, title) {
  return await fetchJsonWithTimeout(
    `http://127.0.0.1:${port}/session?${sessionQuery()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    },
    10,
  );
}

async function sendPrompt(port, sessionID, text, options = {}) {
  const promptText = addOptimizationContext(text, options);
  const requestedModel = options.model || requiredModel();
  const body = {
    model: modelSpec(requestedModel),
    noReply: Boolean(options.noReply),
    parts: [{ type: "text", text: promptText }],
  };
  if (options.agent) body.agent = options.agent;
  if (options.system) body.system = options.system;
  return await fetchJsonWithTimeout(
    messageUrl(port, sessionID),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options.timeoutSec || config.maxWallClockSec || 180,
  );
}

function assistantText(result) {
  const parts = Array.isArray(result?.parts) ? result.parts : [];
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function firstKnownValue(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") return value[key];
  }
  for (const child of Object.values(value)) {
    const found = firstKnownValue(child, keys, depth + 1);
    if (found !== null && found !== undefined && found !== "") return found;
  }
  return null;
}

function finishReason(result) {
  return firstKnownValue(result, [
    "finish_reason",
    "finishReason",
    "stop_reason",
    "stopReason",
    "completion_reason",
    "completionReason",
  ]) || "unknown";
}

function roleOutputCap(role = "main") {
  const caps = config.roleOutputCaps && typeof config.roleOutputCaps === "object" ? config.roleOutputCaps : {};
  return Number(caps[role] || config.outputCapTokens || 8192);
}

function isTruncatedByFinishReason(reason) {
  return ["length", "max_tokens", "max_output_tokens", "truncated", "stop_sequence_length"].includes(String(reason || "").toLowerCase());
}

function cacheStatus(cacheRead, cacheWrite) {
  if (Number(cacheWrite || 0) > 0) return "write-observed";
  if (Number(cacheRead || 0) > 0) return "read-observed-write-zero";
  return "none";
}

function optimizationContext(options = {}) {
  const role = options.role || "main";
  const route = options.model || requiredModel();
  const outputCap = roleOutputCap(role);
  return {
    input_truncated: Boolean(options.inputTruncated),
    output_cap: outputCap,
    route,
    role,
    cache_status: options.cacheStatus || "unknown",
    last_response_truncated: Boolean(options.lastResponseTruncated),
  };
}

function addOptimizationContext(text, options = {}) {
  if (config.includeOptimizationContext === false || options.includeOptimizationContext === false) return text;
  const context = optimizationContext(options);
  return [
    "<optimization_context>",
    JSON.stringify(context),
    "</optimization_context>",
    "",
    text,
  ].join("\n");
}

function turnSummary(result, options = {}) {
  const info = result?.info || {};
  const tokens = info?.tokens || {};
  const cache = tokens?.cache || {};
  const role = options.role || "main";
  const outputCap = roleOutputCap(role);
  const outputTokens = Number(tokens.output || 0);
  const reason = finishReason(result);
  const truncated = isTruncatedByFinishReason(reason);
  const ratio = outputCap > 0 ? outputTokens / outputCap : 0;
  const cacheRead = Number(cache.read || 0);
  const cacheWrite = Number(cache.write || 0);
  return {
    providerID: info.providerID || null,
    modelID: info.modelID || null,
    inputTokens: Number(tokens.input || 0),
    outputTokens,
    cacheWrite,
    cacheRead,
    finishReason: reason,
    truncated,
    outputCap,
    outputCapRatio: Number(ratio.toFixed(4)),
    nearOutputCap: ratio >= Number(config.nearOutputCapRatio || 0.9),
    cacheStatus: cacheStatus(cacheRead, cacheWrite),
    optimizationContext: optimizationContext({
      role,
      model: parseModelRef(info.providerID, info.modelID) || options.model || requiredModel(),
      cacheStatus: cacheStatus(cacheRead, cacheWrite),
      lastResponseTruncated: options.lastResponseTruncated,
    }),
    reply: assistantText(result).slice(0, 200),
  };
}

function roleModelMapFromRouting(routing = {}) {
  return {
    main: routing.model || requiredModel(),
    small: routing.small_model || null,
    plan: routing.plan || null,
    build: routing.build || null,
    general: routing.general || null,
    explore: routing.explore || null,
  };
}

function parseModelRef(providerID, modelID) {
  if (providerID && modelID) return `${providerID}/${modelID}`;
  if (modelID && String(modelID).includes("/")) return String(modelID);
  return modelID || null;
}

function providerFromModel(model) {
  if (!model) return null;
  return String(model).split("/")[0] || null;
}

function modelIDFromModel(model) {
  if (!model) return null;
  const parts = String(model).split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
}

function roleForModel(model, routing = {}) {
  const entries = Object.entries(roleModelMapFromRouting(routing));
  const exact = entries.find(([, value]) => value && value === model);
  if (exact) return exact[0];
  const modelID = modelIDFromModel(model);
  const sameID = entries.find(([, value]) => value && modelIDFromModel(value) === modelID);
  return sameID ? sameID[0] : "unknown";
}

function normalizedTurnEntry(turn, routing = {}, fallback = {}) {
  const model = parseModelRef(turn.providerID, turn.modelID) || fallback.model || null;
  const provider = turn.providerID || providerFromModel(model) || fallback.provider || null;
  return {
    provider,
    role: fallback.role || roleForModel(model, routing),
    model,
    inputTokens: Number(turn.inputTokens || 0),
    outputTokens: Number(turn.outputTokens || 0),
    cacheRead: Number(turn.cacheRead || 0),
    cacheWrite: Number(turn.cacheWrite || 0),
    bodyBytes: Number(turn.bodyBytes || 0),
    finishReason: turn.finishReason || "unknown",
    truncated: Boolean(turn.truncated),
    outputCap: Number(turn.outputCap || roleOutputCap(fallback.role || "main")),
    nearOutputCap: Boolean(turn.nearOutputCap),
    cacheStatus: turn.cacheStatus || cacheStatus(turn.cacheRead, turn.cacheWrite),
  };
}

function normalizedEntriesFromResult(result, routing = {}) {
  const turns = Array.isArray(result?.turns)
    ? result.turns
    : Array.isArray(result?.canary?.turns)
      ? result.canary.turns
      : [];
  return turns.map((turn) => normalizedTurnEntry(turn, routing, { role: "main" }));
}

function extractSignalsFromMessages(messages) {
  const assistant = messages
    .map((message) => message?.info)
    .filter((info) => info?.role === "assistant");
  return {
    providerMinimax: assistant.some((info) => info.providerID === "minimax"),
    agentMinimaxUrl: false,
    promptCachePatched: assistant.some((info) => Number(info?.tokens?.cache?.write || 0) > 0),
    unauthorized: assistant.some((info) => /token is required|Unauthorized/i.test(JSON.stringify(info.error || {}))),
    cacheWrite: assistant.reduce((sum, info) => sum + Number(info?.tokens?.cache?.write || 0), 0),
    cacheRead: assistant.reduce((sum, info) => sum + Number(info?.tokens?.cache?.read || 0), 0),
    inputTokens: assistant.reduce((sum, info) => sum + Number(info?.tokens?.input || 0), 0),
    outputTokens: assistant.reduce((sum, info) => sum + Number(info?.tokens?.output || 0), 0),
    unknownFinishReason: messages.filter((message) => finishReason(message) === "unknown").length,
    truncated: messages.filter((message) => isTruncatedByFinishReason(finishReason(message))).length,
  };
}

async function runCanarySequence(server, args, titlePrefix) {
  const session = await createSession(server.port, `${titlePrefix}-${Date.now()}`);
  const sessionID = session.id;
  const prompts = canaryPrompts(args);

  const timeoutSec = Math.min(config.maxWallClockSec || 180, 75);
  const messages = [];
  const turns = [];
  let lastResponseTruncated = false;
  for (const prompt of prompts) {
    const result = await sendPrompt(server.port, sessionID, prompt.text, {
      timeoutSec,
      role: "main",
      lastResponseTruncated,
    });
    messages.push(result);
    const summary = turnSummary(result, { role: "main", lastResponseTruncated });
    lastResponseTruncated = summary.truncated;
    turns.push({ label: prompt.label, path: prompt.path || null, chars: prompt.chars || prompt.text.length, ...summary });
    const signals = extractSignalsFromMessages(messages);
    if (signals.inputTokens > Number(config.maxInputTokens || 200000)) {
      return {
        sessionID,
        turns,
        replies: turns.map((turn) => turn.reply),
        signals,
        aborted: true,
        abortReason: `canary input tokens exceeded maxInputTokens=${config.maxInputTokens || 200000}`,
      };
    }
  }
  return {
    sessionID,
    turns,
    replies: turns.map((turn) => turn.reply),
    signals: extractSignalsFromMessages(messages),
    aborted: false,
  };
}

function usageSummary(usage) {
  const rows = Array.isArray(usage?.rows) ? usage.rows : [];
  const summary = usage?.summary || {};
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    turns: Number(summary.turns ?? rows.length ?? 0),
    inputTokens: Number(summary.inputTokens ?? 0),
    outputTokens: Number(summary.outputTokens ?? 0),
    cacheReadTokens: Number(summary.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(summary.cacheWriteTokens ?? 0),
    costUsd: Number(summary.costUsd ?? 0),
    last: last ? {
      provider: typeof last.model === "string" ? last.model.split("/")[0] : null,
      model: last.model || null,
      inputTokens: Number(last.inputTokens || 0),
      outputTokens: Number(last.outputTokens || 0),
      cacheReadTokens: Number(last.cacheReadTokens || 0),
      cacheWriteTokens: Number(last.cacheWriteTokens || 0),
    } : null,
  };
}

function readUsage(sessionID) {
  if (!sessionID) return { skipped: true, reason: "no session id" };
  if (!String(sessionID).startsWith("mvs_")) {
    return { skipped: true, sessionID, reason: "not a Mavis session id; pass --session mvs_<id> to collect mavis usage" };
  }
  if (isDeniedSession(sessionID)) {
    return { skipped: true, sessionID, reason: "session is denied" };
  }
  try {
    const usage = runJson(mavisCli(), ["usage", "session", sessionID, "--json"]);
    return { skipped: false, sessionID, summary: usageSummary(usage), raw: usage };
  } catch (error) {
    return { skipped: true, sessionID, reason: error.message };
  }
}

function mavisCli() {
  if (config.mavisCli) return config.mavisCli;
  const cmd = path.join(os.homedir(), ".mavis", "bin", process.platform === "win32" ? "mavis.cmd" : "mavis");
  return fs.existsSync(cmd) ? cmd : "mavis";
}

function routingVerdict(server) {
  const routing = server?.config || {};
  const nonMain = ["small_model", "plan", "build", "general", "explore"];
  const nonMainOpenRouter = nonMain.every((key) => typeof routing[key] === "string" && routing[key].startsWith("openrouter/"));
  return {
    mainDirectM3: routing.model === requiredModel(),
    nonMainOpenRouter,
    routing,
  };
}

function optimizationVerdict({ route, canary, usage }) {
  const maxInputTokens = Number(config.maxInputTokens || 200000);
  const usageSummary2 = usage?.summary;
  const usageInputOk = !usageSummary2 || usageSummary2.inputTokens <= maxInputTokens;
  const providerOk = usageSummary2?.last?.provider ? usageSummary2.last.provider === "minimax" : true;
  const cacheWriteObserved = Boolean((usageSummary2?.cacheWriteTokens || 0) > 0 || (canary?.signals?.cacheWrite || 0) > 0);
  return {
    ok: Boolean(route.mainDirectM3 && route.nonMainOpenRouter && usageInputOk && providerOk),
    mainDirectM3: route.mainDirectM3,
    nonMainOpenRouter: route.nonMainOpenRouter,
    providerMinimax: providerOk,
    inputWithinLimit: usageInputOk,
    maxInputTokens,
    cacheWriteObserved,
    cacheReadObserved: Boolean((usageSummary2?.cacheReadTokens || 0) > 0 || (canary?.signals?.cacheRead || 0) > 0),
    notes: [
      cacheWriteObserved ? "cache write observed" : "cache write not observed; prompt-cache savings remain unproven for this canary",
      usage?.skipped ? `usage skipped: ${usage.reason}` : "usage collected",
    ],
  };
}

function extractSignals(text) {
  return {
    providerMinimax: /providerID=minimax\b/.test(text),
    agentMinimaxUrl: /https:\/\/agent\.minimax\.io\/mavis\/api\/v1\/llm\/v1\/messages/.test(text),
    promptCachePatched: /\[prompt-cache\]\s+enforce_patched/.test(text),
    unauthorized: /token is required|Unauthorized/i.test(text),
    cacheWrite: Number((text.match(/"write":\s*(\d+)/) || [])[1] || 0),
    cacheRead: Number((text.match(/"read":\s*(\d+)/) || [])[1] || 0),
  };
}

function runtimeFileInfo(filePath) {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false };
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
  };
}

function readJsonl(filePath, limit = 50) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/)
    .slice(-limit)
    .map((line) => readJsonFromString(line, null))
    .filter(Boolean);
}

function modeState() {
  return {
    profile: config.env?.MAVIS_CONTEXT_BUDGET_PROFILE || "max",
    promptCacheMode: config.env?.MAVIS_PROMPT_CACHE_MODE || "enforce",
    contextBudgetMode: config.env?.MAVIS_CONTEXT_BUDGET_MODE || "enforce",
    promptCacheOpenRouter: config.env?.MAVIS_PROMPT_CACHE_OPENROUTER || "",
    modes: {
      profile: ["max", "medium", "free"],
      promptCacheMode: ["enforce", "observe", "off"],
      contextBudgetMode: ["enforce", "observe", "off"],
    },
  };
}

function publicConfigSummary() {
  return {
    configPath,
    hasConfigFile: fs.existsSync(configPath),
    defaultModel: config.defaultModel,
    requireModel: requiredModel(),
    mavisDaemonPort: config.mavisDaemonPort,
    sessionDirectory: sessionDirectory(),
    currentMavisSession: config.currentMavisSession || null,
    mvsMaxSendChars: config.mvsMaxSendChars,
    maxWallClockSec: config.maxWallClockSec,
    maxInputTokens: config.maxInputTokens,
    outputCapTokens: config.outputCapTokens,
    nearOutputCapRatio: config.nearOutputCapRatio,
    includeOptimizationContext: config.includeOptimizationContext,
    tinyCanaryInputEstimateTokens: config.tinyCanaryInputEstimateTokens,
    maxLongPromptChars: config.maxLongPromptChars,
    maxLongPromptRepeats: config.maxLongPromptRepeats,
    askSourceContextMode: config.askSourceContextMode,
    askMaxSourceContextChars: config.askMaxSourceContextChars,
    duetPacketMaxChars: config.duetPacketMaxChars,
    asciiConsole: config.asciiConsole,
    denySessionsCount: config.denySessions.length,
    mode: modeState(),
  };
}

function parseConfigValue(value) {
  if (value === null || value === undefined) throw new Error("--value is required");
  const text = String(value);
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function setConfigKey(key, value) {
  if (!key) throw new Error("--key is required");
  const allowedEnv = new Set([
    "MAVIS_PROMPT_CACHE_MODE",
    "MAVIS_CONTEXT_BUDGET_MODE",
    "MAVIS_CONTEXT_BUDGET_PROFILE",
    "MAVIS_PROMPT_CACHE_OPENROUTER",
  ]);
  const allowedTopLevel = new Set([
    "defaultModel",
    "mavisDaemonPort",
    "currentMavisSession",
    "mavisCli",
    "sessionDirectory",
    "mvsMaxSendChars",
    "requireProvider",
    "requireModel",
    "maxTurns",
    "maxWallClockSec",
    "maxInputTokens",
    "outputCapTokens",
    "nearOutputCapRatio",
    "includeOptimizationContext",
    "tinyCanaryInputEstimateTokens",
    "maxLongPromptChars",
    "maxLongPromptRepeats",
    "askSourceContextMode",
    "askMaxSourceContextChars",
    "duetPacketMaxChars",
    "codexCli",
    "codexStepTimeoutSec",
    "asciiConsole",
  ]);
  const next = { ...config, env: { ...(config.env || {}) }, denySessions: [...config.denySessions] };
  if (key.startsWith("env.")) {
    const envKey = key.slice("env.".length);
    if (!envKey) throw new Error("env key is empty");
    if (!allowedEnv.has(envKey)) throw new Error(`unsupported env key: ${envKey}`);
    next.env[envKey] = value;
  } else {
    if (!allowedTopLevel.has(key)) throw new Error(`unsupported config key: ${key}`);
    next[key] = value;
  }
  validateConfig(next);
  return writeConfig(next, `config set ${key}`);
}

function validateNumberRange(configObject, key, min, max) {
  if (configObject[key] === null || configObject[key] === undefined) return;
  const value = Number(configObject[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number from ${min} to ${max}`);
  }
  configObject[key] = value;
}

function validateConfig(configObject) {
  validateNumberRange(configObject, "mavisDaemonPort", 1, 65535);
  validateNumberRange(configObject, "mvsMaxSendChars", 1, 20000);
  validateNumberRange(configObject, "maxTurns", 1, 10);
  validateNumberRange(configObject, "maxWallClockSec", 5, 600);
  validateNumberRange(configObject, "maxInputTokens", 1000, 10000000);
  validateNumberRange(configObject, "outputCapTokens", 128, 65536);
  validateNumberRange(configObject, "nearOutputCapRatio", 0.1, 1);
  validateNumberRange(configObject, "tinyCanaryInputEstimateTokens", 1, 1000000);
  validateNumberRange(configObject, "maxLongPromptChars", 100, 1000000);
  validateNumberRange(configObject, "maxLongPromptRepeats", 1, 10);
  validateNumberRange(configObject, "askMaxSourceContextChars", 0, 200000);
  validateNumberRange(configObject, "duetPacketMaxChars", 1000, 1000000);
  validateNumberRange(configObject, "codexStepTimeoutSec", 5, 1800);
  if (!["auto", "off"].includes(String(configObject.askSourceContextMode || "auto"))) {
    throw new Error("askSourceContextMode must be auto or off");
  }
  if (typeof configObject.defaultModel !== "string" || !configObject.defaultModel.trim()) {
    throw new Error("defaultModel must be a non-empty string");
  }
  if (typeof configObject.requireModel !== "string" || !configObject.requireModel.trim()) {
    throw new Error("requireModel must be a non-empty string");
  }
  if (typeof configObject.codexCli !== "string" || !configObject.codexCli.trim()) {
    throw new Error("codexCli must be a non-empty string");
  }
  if (configObject.requireProvider !== null && configObject.requireProvider !== undefined && typeof configObject.requireProvider !== "string") {
    throw new Error("requireProvider must be a string or null");
  }
  if (configObject.currentMavisSession && !/^mvs_[A-Za-z0-9_-]+$/.test(String(configObject.currentMavisSession))) {
    throw new Error("currentMavisSession must be null or mvs_<id>");
  }
  for (const sessionID of configObject.denySessions || []) {
    if (!/^mvs_[A-Za-z0-9_-]+$/.test(String(sessionID))) {
      throw new Error("denySessions entries must be mvs_<id>");
    }
  }
  if (typeof configObject.asciiConsole !== "boolean") throw new Error("asciiConsole must be boolean");
  if (typeof configObject.includeOptimizationContext !== "boolean") throw new Error("includeOptimizationContext must be boolean");
  const allowedProfile = new Set(["max", "medium", "free"]);
  const allowedMode = new Set(["enforce", "observe", "off"]);
  if (!allowedProfile.has(configObject.env?.MAVIS_CONTEXT_BUDGET_PROFILE)) {
    throw new Error("env.MAVIS_CONTEXT_BUDGET_PROFILE must be max, medium, or free");
  }
  for (const key of ["MAVIS_PROMPT_CACHE_MODE", "MAVIS_CONTEXT_BUDGET_MODE"]) {
    if (!allowedMode.has(configObject.env?.[key])) {
      throw new Error(`env.${key} must be enforce, observe, or off`);
    }
  }
  if (!["", "0", "1"].includes(String(configObject.env?.MAVIS_PROMPT_CACHE_OPENROUTER ?? ""))) {
    throw new Error("env.MAVIS_PROMPT_CACHE_OPENROUTER must be empty, 0, or 1");
  }
}

function redactValue(key, value) {
  if (/key|token|secret|password|auth/i.test(String(key))) return value ? "[redacted]" : value;
  return value;
}

function redactedConfig(configObject) {
  const out = JSON.parse(JSON.stringify(configObject));
  if (out.env && typeof out.env === "object") {
    for (const [key, value] of Object.entries(out.env)) {
      out.env[key] = redactValue(key, value);
    }
  }
  return out;
}

function summarizeLedgerStats(events) {
  const relevant = events.filter((event) => ["canary", "optimize-check"].includes(event.event));
  const totals = {
    events: relevant.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const latest = relevant[relevant.length - 1] || null;
  for (const event of relevant) {
    const signals = event.signals || event.canary?.signals || {};
    totals.inputTokens += Number(signals.inputTokens || 0);
    totals.outputTokens += Number(signals.outputTokens || 0);
    totals.cacheRead += Number(signals.cacheRead || 0);
    totals.cacheWrite += Number(signals.cacheWrite || 0);
  }
  return {
    source: ledgerPath,
    totals,
    latest: latest ? {
      ts: latest.ts || null,
      event: latest.event,
      id: latest.id || null,
      sessionID: latest.sessionID || latest.canary?.sessionID || null,
      verdict: latest.verdict || null,
      signals: latest.signals || latest.canary?.signals || null,
    } : null,
  };
}

function aggregateEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = [entry.provider || "unknown", entry.role || "unknown", entry.model || "unknown"].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        provider: entry.provider || "unknown",
        role: entry.role || "unknown",
        model: entry.model || "unknown",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        maxBodyBytes: 0,
        maxSystemBytes: 0,
        maxMessageBytes: 0,
        maxToolBytes: 0,
        maxBodySessionID: null,
        truncatedTurns: 0,
        nearOutputCapTurns: 0,
        unknownFinishReasonTurns: 0,
      });
    }
    const group = groups.get(key);
    group.requests += 1;
    group.inputTokens += Number(entry.inputTokens || 0);
    group.outputTokens += Number(entry.outputTokens || 0);
    group.cacheRead += Number(entry.cacheRead || 0);
    group.cacheWrite += Number(entry.cacheWrite || 0);
    const bodyBytes = Number(entry.bodyBytes || 0);
    if (bodyBytes > group.maxBodyBytes) {
      group.maxBodyBytes = bodyBytes;
      group.maxBodySessionID = entry.sessionID || null;
    }
    group.maxSystemBytes = Math.max(group.maxSystemBytes, Number(entry.systemBytes || 0));
    group.maxMessageBytes = Math.max(group.maxMessageBytes, Number(entry.messageBytes || 0));
    group.maxToolBytes = Math.max(group.maxToolBytes, Number(entry.toolBytes || 0));
    if (entry.truncated) group.truncatedTurns += 1;
    if (entry.nearOutputCap) group.nearOutputCapTurns += 1;
    if ((entry.finishReason || "unknown") === "unknown") group.unknownFinishReasonTurns += 1;
  }
  return [...groups.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.role.localeCompare(b.role) || a.model.localeCompare(b.model)
  );
}

function latestPluginLogPaths(maxFiles = 3) {
  const logsDir = path.join(os.homedir(), ".mavis", "logs");
  try {
    return fs.readdirSync(logsDir)
      .filter((name) => /^plugin-.*\.log$/i.test(name))
      .map((name) => path.join(logsDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, maxFiles);
  } catch (_) {
    return [];
  }
}

function parsePluginLogLine(line) {
  const match = line.match(/\]\s+\w+\s+\[opencode-plugin\]\s+([a-zA-Z0-9_-]+)\s+(\{.*\})\s*$/);
  if (!match) return null;
  const parsed = readJsonFromString(match[2], null);
  return parsed ? { event: match[1], ...parsed } : null;
}

function readPluginLogEvents(lineLimit = 500) {
  const paths = latestPluginLogPaths(3);
  const lines = [];
  for (const filePath of paths.reverse()) {
    const content = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    lines.push(...content.slice(-lineLimit));
  }
  return lines.slice(-lineLimit).map(parsePluginLogLine).filter(Boolean);
}

function pluginRequestEntries(events, routing = {}) {
  return events
    .filter((event) => event.event === "model_stream_request_start" || event.event === "model_stream_request_summary")
    .map((event) => {
      const provider = event.url?.includes("openrouter.ai") ? "openrouter" : event.url?.includes("agent.minimax.io") ? "minimax" : providerFromModel(event.model);
      const model = provider === "openrouter"
        ? `openrouter/${event.model || "unknown"}`
        : provider === "minimax"
          ? `minimax/${event.model || "unknown"}`
          : event.model || null;
      return {
        provider,
        role: roleForModel(model, routing),
        model,
        bodyBytes: Number(event.bodyBytes || 0),
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        sessionID: event.sessionId || event.sessionID || null,
        messageBytes: Number(event.sectionBytes?.messages || 0),
        systemBytes: Number(event.sectionBytes?.system || 0),
        toolBytes: Number(event.sectionBytes?.tools || 0),
      };
    });
}

function topRequestEntries(entries, limit = 8) {
  return [...entries]
    .sort((a, b) => Number(b.bodyBytes || 0) - Number(a.bodyBytes || 0))
    .slice(0, limit)
    .map((entry) => ({
      provider: entry.provider || "unknown",
      role: entry.role || "unknown",
      model: entry.model || "unknown",
      sessionID: entry.sessionID || null,
      bodyBytes: Number(entry.bodyBytes || 0),
      systemBytes: Number(entry.systemBytes || 0),
      messageBytes: Number(entry.messageBytes || 0),
      toolBytes: Number(entry.toolBytes || 0),
    }));
}

function promptCacheLogSummary(events) {
  const patched = events.filter((event) => event.event === "prompt_cache_enforce_patched");
  const latest = patched[patched.length - 1] || null;
  return {
    enforcePatchedEvents: patched.length,
    latest: latest ? {
      sessionId: latest.sessionId || null,
      breakpointsAdded: latest.breakpointsAdded || 0,
      maxTokensBefore: latest.details?.maxTokensBefore || null,
      maxTokensAfter: latest.details?.maxTokensAfter || null,
      toolDescriptionBytesBefore: latest.details?.toolDescriptionBytesBefore || null,
      toolDescriptionBytesAfter: latest.details?.toolDescriptionBytesAfter || null,
    } : null,
    directMiniMaxCacheVerdict: "unproven: MiniMax direct cache reads may exist, but cacheWrite stays 0 and the source of cacheRead is not isolated",
  };
}

function auditVerdict({ route, ledgerEntries, pluginEntries, promptCache }) {
  const byProvider = aggregateEntries([...ledgerEntries, ...pluginEntries]);
  const openrouterMaxBody = Math.max(0, ...pluginEntries.filter((entry) => entry.provider === "openrouter").map((entry) => entry.bodyBytes || 0));
  const directMaxBody = Math.max(0, ...pluginEntries.filter((entry) => entry.provider === "minimax").map((entry) => entry.bodyBytes || 0));
  const openrouterMaxMessageBytes = Math.max(0, ...pluginEntries.filter((entry) => entry.provider === "openrouter").map((entry) => entry.messageBytes || 0));
  const directMaxMessageBytes = Math.max(0, ...pluginEntries.filter((entry) => entry.provider === "minimax").map((entry) => entry.messageBytes || 0));
  const cacheRead = ledgerEntries.reduce((sum, entry) => sum + Number(entry.cacheRead || 0), 0);
  const cacheWrite = ledgerEntries.reduce((sum, entry) => sum + Number(entry.cacheWrite || 0), 0);
  const truncatedTurns = ledgerEntries.filter((entry) => entry.truncated).length;
  const nearOutputCapTurns = ledgerEntries.filter((entry) => entry.nearOutputCap).length;
  const unknownFinishReasonTurns = ledgerEntries.filter((entry) => (entry.finishReason || "unknown") === "unknown").length;
  const risks = [];
  if (!route.mainDirectM3) risks.push("P0 main route is not direct minimax/MiniMax-M3");
  if (!route.nonMainOpenRouter) risks.push("P1 not all non-main roles are routed through OpenRouter as expected");
  if (openrouterMaxBody > 80000) risks.push(`P0 OpenRouter request body reached ${openrouterMaxBody} bytes; non-main lifecycle traffic can still grow large`);
  if (openrouterMaxMessageBytes > 80000) risks.push(`P0 OpenRouter messages section reached ${openrouterMaxMessageBytes} bytes; history compaction is not protecting lifecycle calls`);
  if (directMaxBody > Number(config.maxInputTokens || 200000)) risks.push(`P1 direct MiniMax request body reached ${directMaxBody} bytes`);
  if (directMaxMessageBytes > Number(config.maxInputTokens || 200000)) risks.push(`P1 direct MiniMax messages section reached ${directMaxMessageBytes} bytes`);
  if (promptCache.enforcePatchedEvents > 0 && cacheWrite === 0) risks.push("P1 prompt-cache patch is active, but MiniMax direct cacheWrite remains 0; savings are unproven");
  if (cacheRead > 0 && cacheWrite === 0) risks.push("P1 cacheRead exists without cacheWrite; run A/B before relying on direct MiniMax cache");
  if (truncatedTurns > 0) risks.push(`P1 response truncation observed in ${truncatedTurns} bridge turn(s); review answers may be incomplete`);
  if (nearOutputCapTurns > 0) risks.push(`P2 ${nearOutputCapTurns} bridge turn(s) were near output cap; consider tighter task slicing`);
  if (unknownFinishReasonTurns > 0) risks.push(`P2 finish_reason was not surfaced for ${unknownFinishReasonTurns} bridge turn(s); truncation detection is incomplete`);
  return {
    ok: risks.length === 0,
    mainDirectM3: route.mainDirectM3,
    nonMainOpenRouter: route.nonMainOpenRouter,
    cacheReadObserved: cacheRead > 0,
    cacheWriteObserved: cacheWrite > 0,
    truncatedTurns,
    nearOutputCapTurns,
    unknownFinishReasonTurns,
    openrouterMaxBodyBytes: openrouterMaxBody,
    directMaxBodyBytes: directMaxBody,
    openrouterMaxMessageBytes,
    directMaxMessageBytes,
    byProviderRoleModel: byProvider,
    risks,
  };
}

async function auditCommand(args) {
  const lines = Number(argValue(args, "--lines", "500"));
  const pluginLines = Number(argValue(args, "--plugin-lines", "800"));
  const sessionID = argValue(args, "--session", null);
  const servers = await liveServers();
  const selected = servers.find((server) => server.config?.model === requiredModel()) || servers[0] || null;
  const routing = selected?.config || {};
  const route = routingVerdict({ config: routing });
  const ledgerEvents = readJsonl(ledgerPath, lines);
  const ledgerEntries = ledgerEvents.flatMap((event) => {
    if (Array.isArray(event.entries)) return event.entries;
    return normalizedEntriesFromResult(event, routing);
  });
  const pluginEvents = readPluginLogEvents(pluginLines);
  const pluginEntries = pluginRequestEntries(pluginEvents, routing);
  const promptCache = promptCacheLogSummary(pluginEvents);
  const usage = sessionID ? readUsage(sessionID) : { skipped: true, reason: "no --session provided" };
  const verdict = auditVerdict({ route, ledgerEntries, pluginEntries, promptCache });
  const out = {
    event: "audit",
    generatedAt: now(),
    routing,
    bridgeConfig: publicConfigSummary(),
    usage,
    ledger: {
      source: ledgerPath,
      eventsRead: ledgerEvents.length,
      entries: aggregateEntries(ledgerEntries),
    },
    pluginLogs: {
      files: latestPluginLogPaths(3),
      eventsRead: pluginEvents.length,
      requests: aggregateEntries(pluginEntries),
      topRequests: topRequestEntries(pluginEntries),
      promptCache,
    },
    verdict,
    notes: [
      "Direct MiniMax cache is treated as unproven until A/B confirms the prompt-cache patch changes cacheRead behavior.",
      "OpenRouter prompt-cache mutation is off unless MAVIS_PROMPT_CACHE_OPENROUTER=1.",
      "Bridge prompts include a compact optimization_context block unless includeOptimizationContext=false.",
      "bodyBytes are request-size evidence, not provider billing tokens.",
    ],
  };
  appendJsonl(ledgerPath, {
    event: "audit",
    provider: "mixed",
    role: "audit",
    model: "mixed",
    sessionID,
    risks: verdict.risks,
    openrouterMaxBodyBytes: verdict.openrouterMaxBodyBytes,
    directMaxBodyBytes: verdict.directMaxBodyBytes,
  });
  printJson(out);
}

async function statusCommand() {
  const servers = await liveServers();
  appendJsonl(ledgerPath, { event: "status", servers });
  printJson({ servers });
}

async function stateCommand() {
  const servers = await liveServers();
  const events = readJsonl(ledgerPath, 20);
  const out = {
    event: "state",
    serverCount: servers.length,
    servers,
    config: publicConfigSummary(),
    runtimeFiles: {
      config: runtimeFileInfo(configPath),
      ledger: runtimeFileInfo(ledgerPath),
      inbox: runtimeFileInfo(inboxPath),
      outbox: runtimeFileInfo(outboxPath),
      duetState: runtimeFileInfo(duetStatePath),
      duetJournal: runtimeFileInfo(duetJournalPath),
      duetLock: runtimeFileInfo(duetLockPath),
    },
    latestLedgerEvents: events.slice(-5).map((event) => ({
      ts: event.ts || null,
      event: event.event || null,
      id: event.id || null,
      sessionID: event.sessionID || event.canary?.sessionID || null,
    })),
  };
  appendJsonl(ledgerPath, { event: "state", serverCount: servers.length });
  printJson(out);
}

function configCommand(args) {
  const [sub] = args;
  if (!sub || sub === "show") {
    return printJson({ event: "config", config: publicConfigSummary(), raw: redactedConfig(config) });
  }
  if (sub === "set") {
    const key = argValue(args, "--key");
    const value = parseConfigValue(argValue(args, "--value"));
    const next = setConfigKey(key, value);
    return printJson({ event: "config-updated", key, value: redactValue(key, value), config: publicConfigSummary(), raw: redactedConfig(next) });
  }
  throw new Error(`unknown config command: ${sub}`);
}

function modeCommand(args) {
  const [sub] = args;
  if (!sub || sub === "list" || sub === "show") {
    return printJson({ event: "mode", ...modeState() });
  }
  if (sub !== "set") throw new Error(`unknown mode command: ${sub}`);
  const profile = argValue(args, "--profile");
  const promptCache = argValue(args, "--prompt-cache");
  const contextBudget = argValue(args, "--context-budget");
  const allowedProfile = new Set(["max", "medium", "free"]);
  const allowedMode = new Set(["enforce", "observe", "off"]);
  const next = { ...config, env: { ...(config.env || {}) }, denySessions: [...config.denySessions] };
  if (profile) {
    if (!allowedProfile.has(profile)) throw new Error(`unsupported profile: ${profile}`);
    next.env.MAVIS_CONTEXT_BUDGET_PROFILE = profile;
  }
  if (promptCache) {
    if (!allowedMode.has(promptCache)) throw new Error(`unsupported prompt-cache mode: ${promptCache}`);
    next.env.MAVIS_PROMPT_CACHE_MODE = promptCache;
  }
  if (contextBudget) {
    if (!allowedMode.has(contextBudget)) throw new Error(`unsupported context-budget mode: ${contextBudget}`);
    next.env.MAVIS_CONTEXT_BUDGET_MODE = contextBudget;
  }
  if (!profile && !promptCache && !contextBudget) {
    throw new Error("mode set requires --profile, --prompt-cache, or --context-budget");
  }
  writeConfig(next, "mode set");
  printJson({ event: "mode-updated", ...modeState() });
}

function sessionCommand(args) {
  const [sub] = args;
  if (!sub || sub === "show") {
    return printJson({ event: "session", currentMavisSession: config.currentMavisSession || null });
  }
  const next = { ...config, env: { ...(config.env || {}) }, denySessions: [...config.denySessions] };
  if (sub === "set") {
    const sessionID = argValue(args, "--session");
    assertMvsSessionID(sessionID, "session set");
    assertNotDeniedSession(sessionID, "session set");
    next.currentMavisSession = sessionID;
  } else if (sub === "clear") {
    next.currentMavisSession = null;
  } else {
    throw new Error(`unknown session command: ${sub}`);
  }
  writeConfig(next, `session ${sub}`);
  printJson({ event: "session-updated", currentMavisSession: config.currentMavisSession || null });
}

function denySessionCommand(args) {
  const [sub] = args;
  if (!sub || sub === "list") {
    return printJson({ event: "deny-session", denySessions: config.denySessions });
  }
  const sessionID = argValue(args, "--session");
  if (!sessionID) throw new Error(`${sub} requires --session <id>`);
  assertMvsSessionID(sessionID, `deny-session ${sub}`);
  const next = { ...config, env: { ...(config.env || {}) }, denySessions: [...config.denySessions] };
  if (sub === "add") {
    next.denySessions = [...new Set([...next.denySessions, sessionID])];
  } else if (sub === "remove") {
    next.denySessions = next.denySessions.filter((item) => item !== sessionID);
  } else {
    throw new Error(`unknown deny-session command: ${sub}`);
  }
  writeConfig(next, `deny-session ${sub}`);
  printJson({ event: "deny-session-updated", denySessions: config.denySessions });
}

function tokenStatsCommand(args) {
  const sessionID = argValue(args, "--session", null);
  const lines = Number(argValue(args, "--lines", "100"));
  const out = {
    event: "token-stats",
    usage: sessionID ? readUsage(sessionID) : { skipped: true, reason: "no --session provided" },
    ledger: args.includes("--ledger") || !sessionID ? summarizeLedgerStats(readJsonl(ledgerPath, lines)) : null,
  };
  appendJsonl(ledgerPath, { event: "token-stats", sessionID, ledger: Boolean(out.ledger) });
  printJson(out);
}

function canaryEstimateCommand(args) {
  const estimate = canaryEstimate(args);
  appendJsonl(ledgerPath, estimate);
  printJson(estimate);
}

async function canaryCommand(args) {
  requireSpendingApproval(args, "canary");
  const server = await selectServer(args);
  const canary = await runCanarySequence(server, args, "bridge-canary");
  const result = {
    event: "canary",
    provider: "minimax",
    role: "main",
    model: requiredModel(),
    port: server.port,
    entries: normalizedEntriesFromResult(canary, server.config),
    ...canary,
  };
  appendJsonl(ledgerPath, result);
  appendJsonl(outboxPath, result);
  printJson(result);
}

async function optimizeCheckCommand(args) {
  const server = await selectServer(args);
  const route = routingVerdict(server);
  let canary = null;
  if (!args.includes("--skip-canary")) {
    requireSpendingApproval(args, "optimize-check");
    canary = await runCanarySequence(server, args, "bridge-optimize-check");
  }
  const usageSession = argValue(args, "--session", canary?.sessionID || null);
  const usage = readUsage(usageSession);
  const verdict = optimizationVerdict({ route, canary, usage });
  const result = {
    event: "optimize-check",
    id: cryptoRandomID(),
    provider: "mixed",
    role: "optimize-check",
    model: "mixed",
    port: server.port,
    estimate: args.includes("--skip-canary") ? null : canaryEstimate(args),
    route,
    canary,
    entries: canary ? normalizedEntriesFromResult(canary, server.config) : [],
    usage,
    verdict,
  };
  appendJsonl(ledgerPath, result);
  appendJsonl(outboxPath, result);
  printJson(result);
}

async function askCommand(args) {
  const dryRun = args.includes("--dry-run");
  const raw = args.includes("--raw");
  if (!dryRun) {
    requireSpendingApproval(args, "ask");
  }
  const mode = argValue(args, "--mode", "review-only");
  if (!["review-only", "patch-proposal"].includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  const taskPaths = argValues(args, "--task");
  if (taskPaths.length === 0) throw new Error("--task is required");
  const tasks = taskPaths.map((taskPath) => ({
    taskPath: path.resolve(taskPath),
    text: fs.readFileSync(path.resolve(taskPath), "utf8"),
  }));
  const sourceContext = buildAskSourceContext(args, tasks.map((task) => task.taskPath));
  const promptTasks = tasks.map((task, index) => ({
    ...task,
    promptText: index === 0 && sourceContext.included ? `${task.text}\n\n${sourceContext.text}` : task.text,
  }));
  const preflight = assertTaskBudget(promptTasks.map((task) => ({ taskPath: task.taskPath, text: task.promptText })));
  const sourceContextSummary = {
    mode: sourceContext.mode,
    included: sourceContext.included,
    reason: sourceContext.reason,
    chars: sourceContext.chars,
    maxChars: sourceContext.maxChars || null,
    truncated: sourceContext.truncated,
    untrackedCount: sourceContext.untrackedCount || 0,
    includeCount: sourceContext.includeCount || 0,
    includeSkippedCount: sourceContext.includeSkippedCount || 0,
    includePaths: sourceContext.includePaths || [],
    includeLimits: sourceContext.includeLimits || null,
    repoRoot: sourceContext.repoRoot || null,
  };
  if (dryRun) {
    const prompts = promptTasks.map((task, index) => {
      const text = mode === "review-only"
        ? `Review only. Do not edit files. Answer concisely.\n\n${task.promptText}`
        : `Propose a unified diff only. Do not apply it.\n\n${task.promptText}`;
      return {
        index: index + 1,
        taskPath: task.taskPath,
        chars: text.length,
        sha256: sha256(text),
        text: raw ? text : undefined,
      };
    });
    return printJson({
      event: "ask-dry-run",
      mode,
      raw,
      taskPath: tasks[0].taskPath,
      taskPaths: tasks.map((task) => task.taskPath),
      turnsRequested: tasks.length,
      chars: promptTasks.reduce((sum, task) => sum + task.promptText.length, 0),
      preflight,
      sourceContext: raw ? { ...sourceContextSummary, text: sourceContext.text } : sourceContextSummary,
      prompts,
    });
  }
  const server = await selectServer(args);
  const envelope = {
    event: "ask",
    id: cryptoRandomID(),
    mode,
    port: server.port,
    taskPath: tasks[0].taskPath,
    taskPaths: tasks.map((task) => task.taskPath),
    turnsRequested: tasks.length,
    chars: promptTasks.reduce((sum, task) => sum + task.promptText.length, 0),
    preflight,
    sourceContext: sourceContextSummary,
  };
  appendJsonl(inboxPath, envelope);

  const session = await createSession(server.port, `bridge-ask-${Date.now()}`);
  const results = [];
  const turns = [];
  const timeoutSec = config.maxWallClockSec || 180;
  let lastResponseTruncated = false;
  for (let index = 0; index < promptTasks.length; index += 1) {
    const task = promptTasks[index];
    const prompt = mode === "review-only"
      ? `Review only. Do not edit files. Answer concisely.\n\n${task.promptText}`
      : `Propose a unified diff only. Do not apply it.\n\n${task.promptText}`;
    const result = await sendPrompt(server.port, session.id, prompt, {
      timeoutSec,
      role: "main",
      lastResponseTruncated,
    });
    results.push(result);
    const answer = assistantText(result);
    const summary = turnSummary(result, { role: "main", lastResponseTruncated });
    lastResponseTruncated = summary.truncated;
    turns.push({
      index: index + 1,
      taskPath: task.taskPath,
      chars: task.promptText.length,
      ...summary,
      answer: answer.slice(-12000),
    });
    const signals = extractSignalsFromMessages(results);
    if (signals.inputTokens > Number(config.maxInputTokens || 200000)) {
      break;
    }
  }
  const signals = extractSignalsFromMessages(results);
  const out = { ...envelope, sessionID: session.id, signals, turns, answer: turns.at(-1)?.answer || "" };
  out.provider = turns.length > 0 ? turns[0].providerID || "minimax" : "minimax";
  out.role = "main";
  out.model = turns.length > 0 ? parseModelRef(turns[0].providerID, turns[0].modelID) || requiredModel() : requiredModel();
  out.entries = turns.map((turn) => normalizedTurnEntry(turn, server.config, { role: "main" }));
  appendJsonl(ledgerPath, out);
  appendJsonl(outboxPath, out);
  printJson(out);
}

async function mvsStatusCommand(args) {
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
  const statusID = argValue(args, "--opencode-session", sessionID);
  const { status } = await verifyMavisSession(port, sessionID, {
    statusID,
    allowMismatch: args.includes("--allow-mismatch"),
    action: "mvs-status",
  });
  const out = { event: "mvs-status", port, requestedSession: sessionID, statusID, status };
  appendJsonl(ledgerPath, out);
  printJson(out);
}

async function mvsPeersCommand(args) {
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
  await verifyMavisSession(port, sessionID, { action: "mvs-peers" });
  const peers = await fetchMavisJson(`/communication/peers?sessionId=${encodeURIComponent(sessionID)}`, { port }, 15);
  const out = { event: "mvs-peers", port, sessionID, peers };
  appendJsonl(ledgerPath, out);
  printJson(out);
}

async function mvsMessagesCommand(args) {
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
  await verifyMavisSession(port, sessionID, { action: "mvs-messages" });
  const limit = Number(argValue(args, "--limit", "10"));
  const query = `toSession=${encodeURIComponent(sessionID)}&limit=${encodeURIComponent(String(limit))}`;
  const messages = await fetchMavisJson(`/communication/messages?${query}`, { port }, 15);
  const out = { event: "mvs-messages", port, sessionID, messages };
  appendJsonl(ledgerPath, out);
  printJson(out);
}

async function mvsSendCommand(args) {
  if (!args.includes("--yes")) {
    throw new Error("mvs-send requires --yes because it triggers a model turn in the target session");
  }
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
  const taskPath = argValue(args, "--task");
  const inline = argValue(args, "--content");
  if (!taskPath && !inline) throw new Error("mvs-send requires --content or --task");
  if (inline && !args.includes("--allow-inline-content")) {
    throw new Error("mvs-send --content requires --allow-inline-content; prefer --task to avoid shell history leaks");
  }
  await verifyMavisSession(port, sessionID, { action: "mvs-send" });
  const content = taskPath ? fs.readFileSync(path.resolve(taskPath), "utf8") : inline;
  const maxChars = Number(config.mvsMaxSendChars || 4000);
  if (content.length > maxChars) {
    throw new Error(`mvs-send content too large: ${content.length} chars > ${maxChars}`);
  }
  const result = await fetchMavisJson(
    "/communication/send",
    {
      port,
      fetchOptions: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromSession: "user",
          toSession: sessionID,
          command: "prompt",
          content,
        }),
      },
    },
    config.maxWallClockSec || 180,
  );
  const out = { event: "mvs-send", port, sessionID, chars: content.length, result };
  appendJsonl(ledgerPath, out);
  appendJsonl(outboxPath, out);
  printJson(out);
}

function cryptoRandomID() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function redactedLogValue(value, key = "") {
  if (value === null || value === undefined) return value;
  if (/session|message|prompt|answer|content|text|commandLine|raw|status|result/i.test(String(key))) {
    if (typeof value === "string") return value ? "[redacted]" : value;
    if (Array.isArray(value)) return `[redacted ${value.length} items]`;
    if (typeof value === "object") return "[redacted object]";
  }
  if (Array.isArray(value)) return value.map((item) => redactedLogValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactedLogValue(childValue, childKey)]));
  }
  return value;
}

function redactLogLine(line) {
  const parsed = readJsonFromString(line, null);
  if (!parsed) return line.replace(/mvs_[A-Za-z0-9_-]+/g, "mvs_[redacted]");
  return JSON.stringify(redactedLogValue(parsed));
}

function tailCommand(args) {
  const lines = Number(argValue(args, "--lines", "20"));
  const raw = args.includes("--raw");
  for (const filePath of [ledgerPath, outboxPath]) {
    console.log(`\n== ${path.basename(filePath)} ==`);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).slice(-lines);
    for (const line of content) console.log(raw ? line : redactLogLine(line));
  }
}

const duetAgents = new Set(["codex", "minimax"]);
const duetStatuses = new Set(["running", "done", "human_escalation"]);

function requireDuetAgent(value, label) {
  if (!duetAgents.has(value)) {
    throw new Error(`${label} must be one of: codex, minimax`);
  }
  return value;
}

function requireDuetStatus(value) {
  if (!duetStatuses.has(value)) {
    throw new Error("status must be one of: running, done, human_escalation");
  }
  return value;
}

function requireDuetPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function readRequiredText(filePath, label, maxChars = null) {
  if (!filePath) throw new Error(`${label} is required`);
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} file not found: ${resolved}`);
  const text = fs.readFileSync(resolved, "utf8").trim();
  if (!text) throw new Error(`${label} file is empty: ${resolved}`);
  if (maxChars !== null && text.length > maxChars) {
    throw new Error(`${label} file is too large (${text.length} chars); keep duet entries <= ${maxChars} chars`);
  }
  return text;
}

function readDuetHandoffText(filePath) {
  if (!filePath) throw new Error("--handoff is required");
  if (String(filePath).includes("\0")) throw new Error("--handoff must not contain NUL bytes");
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) throw new Error(`--handoff file not found: ${resolved}`);
  const realPath = realpathOrResolve(resolved);
  if (!isPathInsideRoot(bridgeDir, realPath)) {
    throw new Error(`--handoff path escapes bridge root: ${resolved}`);
  }
  const stats = fs.statSync(realPath);
  if (!stats.isFile()) throw new Error(`--handoff is not a regular file: ${realPath}`);
  const text = fs.readFileSync(realPath, "utf8").trim();
  if (!text) throw new Error(`--handoff file is empty: ${realPath}`);
  if (text.length > duetMaxEntryChars) {
    throw new Error(`--handoff file is too large (${text.length} chars); keep duet entries <= ${duetMaxEntryChars} chars`);
  }
  return text;
}

function writeTextAtomic(filePath, text) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, filePath);
}

function writeDuetState(state) {
  writeTextAtomic(duetStatePath, stableStringify(state));
}

function validateDuetState(state) {
  const fail = (message) => {
    throw new Error(`invalid duet state: ${message}`);
  };
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("expected object");
  if (typeof state.goal !== "string" || !state.goal.trim()) fail("goal must be a non-empty string");
  if (!duetStatuses.has(state.status)) fail("status must be one of: running, done, human_escalation");
  if (state.status === "running") {
    if (!duetAgents.has(state.baton)) fail("baton must be one of: codex, minimax");
  } else if (state.baton !== null) {
    fail("baton must be null unless status is running");
  }
  if (!Number.isSafeInteger(state.iteration) || state.iteration < 1) fail("iteration must be a positive integer");
  if (!Number.isSafeInteger(state.maxIterations) || state.maxIterations < 1) fail("maxIterations must be a positive integer");
  if (state.iteration > state.maxIterations) fail("iteration cannot exceed maxIterations");
  if (typeof state.lastHandoff !== "string") fail("lastHandoff must be a string");
  if (state.humanEscalation !== null && typeof state.humanEscalation !== "string") {
    fail("humanEscalation must be null or a string");
  }
  if (state.status === "human_escalation" && !state.humanEscalation) {
    fail("humanEscalation is required when status is human_escalation");
  }
  return state;
}

function readDuetState() {
  if (!fs.existsSync(duetStatePath)) {
    throw new Error("duet state is not initialized; run `duet init` first");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(duetStatePath, "utf8"));
  } catch (error) {
    throw new Error(`duet state is not valid JSON: ${error.message}`);
  }
  return validateDuetState(parsed);
}

function readDuetJournal() {
  if (!fs.existsSync(duetJournalPath)) {
    throw new Error("duet journal is missing; restore duet-journal.md or run `duet init --force`");
  }
  const journal = fs.readFileSync(duetJournalPath, "utf8");
  if (!journal.trim()) {
    throw new Error("duet journal is empty; restore duet-journal.md or run `duet init --force`");
  }
  return journal;
}

function truncateDuetText(text, limit = 2000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}\n...[truncated]`;
}

function textDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function safeFileTimestamp(ts = now()) {
  return ts.replace(/[^0-9A-Za-z_-]/g, "-");
}

function textSummary(text) {
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    sha256: textDigest(text),
  };
}

function publicDuetState(state) {
  return {
    baton: state.baton,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    status: state.status,
    goal: textSummary(state.goal),
    lastHandoff: state.lastHandoff ? textSummary(state.lastHandoff) : null,
    humanEscalation: state.humanEscalation ? textSummary(state.humanEscalation) : null,
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
  };
}

function tailLines(text, count) {
  const lines = text ? text.split(/\r?\n/) : [];
  return lines.slice(-count).join("\n");
}

function requireSafeRawOutputPath(outPath) {
  const base = path.basename(outPath).toLowerCase();
  if (base.includes(".local.") || base.endsWith(".local.md") || base.endsWith(".local.json")) return;
  throw new Error("--raw --out requires a .local.* output path");
}

function resolveDuetOutputPath(outPathArg, raw) {
  if (!outPathArg) return null;
  if (String(outPathArg).includes("\0")) throw new Error("--out must not contain NUL bytes");
  const resolved = path.resolve(process.cwd(), outPathArg);
  if (raw) requireSafeRawOutputPath(resolved);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) throw new Error(`--out parent directory not found: ${parent}`);
  const realParent = realpathOrResolve(parent);
  if (!isPathInsideRoot(bridgeDir, realParent)) {
    throw new Error(`--out path escapes bridge root: ${resolved}`);
  }
  return path.join(realParent, path.basename(resolved));
}

function safeLedgerEvent(event) {
  return {
    ts: event.ts || null,
    event: event.event || null,
    id: event.id || null,
    mode: event.mode || null,
    status: event.status || null,
    baton: event.baton || null,
    from: event.from || null,
    to: event.to || null,
    sessionID: event.sessionID || null,
    turnsRequested: event.turnsRequested || null,
    chars: event.chars || null,
    sourceContext: event.sourceContext || null,
    verdict: event.verdict || null,
  };
}

function duetTranscriptExport(args) {
  const format = argValue(args, "--format", "json");
  if (!["json", "markdown"].includes(format)) {
    throw new Error("--format must be json or markdown");
  }
  const raw = args.includes("--raw");
  const outPathArg = argValue(args, "--out", null);
  const journalLines = positiveIntegerArg(args, "--journal-lines", "80");
  const ledgerLines = positiveIntegerArg(args, "--ledger-lines", "50");
  if (raw && outPathArg) requireSafeRawOutputPath(path.resolve(process.cwd(), outPathArg));

  const state = readDuetState();
  const journal = readDuetJournal();
  const ledgerEvents = args.includes("--include-ledger") ? readJsonl(ledgerPath, ledgerLines).map(safeLedgerEvent) : [];
  const payload = {
    event: "duet-transcript-export",
    generatedAt: now(),
    raw,
    format,
    statePath: duetStatePath,
    journalPath: duetJournalPath,
    ledgerPath: args.includes("--include-ledger") ? ledgerPath : null,
    state: publicDuetState(state),
    journal: raw
      ? { ...textSummary(journal), text: journal }
      : { ...textSummary(journal), tail: textSummary(tailLines(journal, journalLines)), tailLines: journalLines },
    ledger: args.includes("--include-ledger") ? {
      lines: ledgerLines,
      events: raw ? ledgerEvents : ledgerEvents.map((event) => ({ ...event, sourceContext: event.sourceContext ? { ...event.sourceContext, text: undefined } : null })),
    } : null,
  };

  const rendered = format === "json" ? stableStringify(payload) : renderDuetTranscriptMarkdown(payload);
  if (outPathArg) {
    const outPath = path.resolve(process.cwd(), outPathArg);
    fs.writeFileSync(outPath, rendered, "utf8");
    return printJson({
      event: "duet-transcript-export",
      raw,
      format,
      outPath,
      chars: rendered.length,
      sha256: textDigest(rendered),
    });
  }
  process.stdout.write(config.asciiConsole === false ? rendered : escapeNonAscii(rendered));
}

function renderDuetTranscriptMarkdown(payload) {
  const lines = [
    "# Duet Transcript Export",
    "",
    `Generated: ${payload.generatedAt}`,
    `Raw: ${payload.raw}`,
    `Status: ${payload.state.status}`,
    `Baton: ${payload.state.baton ?? "none"}`,
    `Iteration: ${payload.state.iteration}/${payload.state.maxIterations}`,
    "",
    "## State",
    "",
    "```json",
    JSON.stringify(payload.state, null, 2),
    "```",
    "",
    "## Journal",
    "",
  ];
  if (payload.raw) {
    lines.push(payload.journal.text);
  } else {
    lines.push(`Chars: ${payload.journal.chars}`);
    lines.push(`Lines: ${payload.journal.lines}`);
    lines.push(`SHA-256: ${payload.journal.sha256}`);
    lines.push(`Tail lines summarized: ${payload.journal.tailLines}`);
    lines.push(`Tail SHA-256: ${payload.journal.tail.sha256}`);
  }
  if (payload.ledger) {
    lines.push("", "## Ledger", "", "```json", JSON.stringify(payload.ledger.events, null, 2), "```");
  }
  lines.push("");
  return lines.join("\n");
}

function printDuetEvent(event, state, args, extra = {}) {
  const raw = args.includes("--raw");
  printJson({
    event,
    statePath: duetStatePath,
    journalPath: duetJournalPath,
    raw,
    ...extra,
    state: raw ? state : publicDuetState(state),
  });
}

function lastDuetVerifierSummary(journal) {
  const pattern = /^## Verify - (codex|minimax) - ([^\r\n]+)\r?\n\r?\nstatus=([^\s]+) exit=([^\s]+) durationMs=([^\s]+) verifier=(.+) sha=([^\s]+)$/gm;
  let latest = null;
  let match;
  while ((match = pattern.exec(journal)) !== null) {
    latest = {
      agent: match[1],
      endedAt: match[2],
      status: match[3],
      exit: match[4] === "null" ? null : match[4],
      durationMs: Number(match[5]),
      verifier: match[6],
      sha: match[7],
    };
  }
  return latest;
}

function duetNextWarnings(state, requestedAgent) {
  const warnings = [];
  if (state.status === "done") warnings.push("done");
  if (state.status === "human_escalation") warnings.push("human_escalation");
  if (state.status === "running" && state.iteration >= state.maxIterations) warnings.push("max_iterations_reached");
  if (state.status === "running" && requestedAgent && requestedAgent !== state.baton) warnings.push("wrong_baton");
  return warnings;
}

function canDuetAgentAct(state, agent) {
  return state.status === "running"
    && agent === state.baton
    && state.iteration < state.maxIterations;
}

function duetNextActions(state, requestedAgent, allowedToAct) {
  const inspect = [
    "node .\\bridge.mjs duet show",
    "node .\\bridge.mjs duet transcript export",
  ];
  if (state.status !== "running") {
    return { inspect, act: [], recover: [] };
  }
  const recover = allowedToAct
    ? []
    : [
      `node .\\bridge.mjs duet pass --from ${state.baton} --to ${requestedAgent || nextDuetAgent(state.baton)} --handoff <file>`,
    ];
  const act = allowedToAct
    ? [
      `node .\\bridge.mjs duet pass --from ${requestedAgent} --to ${nextDuetAgent(requestedAgent)} --handoff <file>`,
      `node .\\bridge.mjs duet pass --from ${requestedAgent} --status done --handoff <file>`,
      `node .\\bridge.mjs duet pass --from ${requestedAgent} --status human_escalation --handoff <file>`,
    ]
    : [];
  return { inspect, act, recover };
}

function duetNextCommand(args) {
  const state = readDuetState();
  const journal = readDuetJournal();
  const requestedAgentRaw = argValue(args, "--agent", state.status === "running" ? state.baton : null);
  const requestedAgent = requestedAgentRaw ? requireDuetAgent(requestedAgentRaw, "--agent") : null;
  const raw = args.includes("--raw");
  const allowedToAct = canDuetAgentAct(state, requestedAgent);
  const warnings = duetNextWarnings(state, requestedAgent);
  printJson({
    event: "duet-next",
    statePath: duetStatePath,
    journalPath: duetJournalPath,
    raw,
    agent: requestedAgent,
    baton: state.baton,
    status: state.status,
    allowedToAct,
    warning: warnings[0] || null,
    warnings,
    nextActions: duetNextActions(state, requestedAgent, allowedToAct),
    lastVerifier: lastDuetVerifierSummary(journal),
    state: raw ? state : publicDuetState(state),
    journal: raw ? { ...textSummary(journal), tail: tailLines(journal, 80) } : textSummary(journal),
  });
}

function truncatePacketText(text, limit) {
  const marker = "\n[truncated: packet character budget reached]";
  if (text.length <= limit) return { text, truncated: false };
  const keep = Math.max(0, limit - marker.length);
  return { text: `${text.slice(0, keep)}${marker}`, truncated: true };
}

function packetTextField(text, raw, limit) {
  if (!raw) return textSummary(text);
  const truncated = truncatePacketText(text, limit);
  return {
    ...textSummary(text),
    text: truncated.text,
    truncated: truncated.truncated,
  };
}

function buildDuetPacketPayload(agent, raw, textLimit) {
  const state = readDuetState();
  const journal = readDuetJournal();
  const allowedToAct = canDuetAgentAct(state, agent);
  const warnings = duetNextWarnings(state, agent);
  const journalTail = tailLines(journal, 120);
  return {
    event: "duet-packet-export",
    generatedAt: now(),
    raw,
    agent,
    projection: {
      source: "duet-state.json + duet-journal.md",
      runtimeArtifact: false,
      separateStateSchema: false,
    },
    statePath: duetStatePath,
    journalPath: duetJournalPath,
    status: state.status,
    baton: state.baton,
    allowedToAct,
    warning: warnings[0] || null,
    warnings,
    nextActions: duetNextActions(state, agent, allowedToAct),
    allowedCompletionStatuses: ["running", "done", "human_escalation"],
    lastVerifier: lastDuetVerifierSummary(journal),
    state: raw ? state : publicDuetState(state),
    goal: packetTextField(state.goal, raw, textLimit),
    lastHandoff: state.lastHandoff ? packetTextField(state.lastHandoff, raw, textLimit) : null,
    journal: raw
      ? packetTextField(journalTail, raw, textLimit)
      : { ...textSummary(journal), tail: textSummary(journalTail), tailLines: 120 },
  };
}

function renderDuetPacketMarkdown(payload) {
  const lines = [
    "# Duet Packet",
    "",
    `Generated: ${payload.generatedAt}`,
    `Raw: ${payload.raw}`,
    `Agent: ${payload.agent}`,
    `Status: ${payload.status}`,
    `Baton: ${payload.baton ?? "none"}`,
    `Allowed to act: ${payload.allowedToAct}`,
    `Warnings: ${payload.warnings.length ? payload.warnings.join(", ") : "none"}`,
    "",
    "## Projection",
    "",
    "- Derived from `duet-state.json` and `duet-journal.md`.",
    "- Not a runtime artifact.",
    "- No separate state schema.",
    "",
    "## Next Actions",
    "",
    "```json",
    JSON.stringify(payload.nextActions, null, 2),
    "```",
    "",
    "## Goal",
    "",
  ];
  if (payload.raw) {
    lines.push(payload.goal.text);
  } else {
    lines.push("```json", JSON.stringify(payload.goal, null, 2), "```");
  }
  lines.push("", "## Last Handoff", "");
  if (!payload.lastHandoff) {
    lines.push("None");
  } else if (payload.raw) {
    lines.push(payload.lastHandoff.text);
  } else {
    lines.push("```json", JSON.stringify(payload.lastHandoff, null, 2), "```");
  }
  lines.push("", "## Latest Verifier", "", "```json", JSON.stringify(payload.lastVerifier, null, 2), "```", "", "## Journal", "");
  if (payload.raw) {
    lines.push(payload.journal.text);
  } else {
    lines.push("```json", JSON.stringify(payload.journal, null, 2), "```");
  }
  lines.push("");
  return lines.join("\n");
}

function renderDuetPacket(payload, format) {
  return format === "json" ? stableStringify(payload) : renderDuetPacketMarkdown(payload);
}

function createBoundedDuetPacket(agent, raw, format, maxPacketChars) {
  let textLimit = Math.max(80, Math.floor(maxPacketChars / 4));
  const finalize = (payload) => {
    const firstPass = {
      ...payload,
      packet: {
        maxChars: maxPacketChars,
        renderedChars: null,
        overBudget: null,
      },
    };
    const rendered = renderDuetPacket(firstPass, format);
    let finalPayload = {
      ...firstPass,
      packet: {
        ...firstPass.packet,
        renderedChars: rendered.length,
        overBudget: rendered.length > maxPacketChars,
      },
    };
    let finalRendered = renderDuetPacket(finalPayload, format);
    finalPayload = {
      ...finalPayload,
      packet: {
        ...finalPayload.packet,
        renderedChars: finalRendered.length,
        overBudget: finalRendered.length > maxPacketChars,
      },
    };
    finalRendered = renderDuetPacket(finalPayload, format);
    return { payload: finalPayload, rendered: finalRendered };
  };
  let packet = finalize(buildDuetPacketPayload(agent, raw, textLimit));
  while (packet.rendered.length > maxPacketChars && textLimit > 80) {
    textLimit = Math.max(80, Math.floor(textLimit * 0.65));
    packet = finalize(buildDuetPacketPayload(agent, raw, textLimit));
  }
  return packet;
}

function duetPacketExport(args) {
  const action = args[0];
  if (action !== "export") throw new Error("unknown duet packet command; expected `duet packet export`");
  const rest = args.slice(1);
  const format = argValue(rest, "--format", "json");
  if (!["json", "markdown"].includes(format)) throw new Error("--format must be json or markdown");
  const raw = rest.includes("--raw");
  const agent = requireDuetAgent(argValue(rest, "--agent"), "--agent");
  if (agent !== "minimax") throw new Error("--agent minimax is the only supported packet export target in Phase 4A");
  const configuredMax = Number(config.duetPacketMaxChars || 60000);
  const maxPacketChars = positiveIntegerArg(rest, "--max-packet-chars", String(configuredMax));
  const maxLongPromptChars = Number(config.maxLongPromptChars || 160000);
  if (maxPacketChars > maxLongPromptChars) {
    throw new Error(`--max-packet-chars must be <= maxLongPromptChars=${maxLongPromptChars}`);
  }
  const outPath = resolveDuetOutputPath(argValue(rest, "--out", null), raw);
  const packet = createBoundedDuetPacket(agent, raw, format, maxPacketChars);
  const rendered = packet.rendered;
  if (outPath) {
    fs.writeFileSync(outPath, rendered, "utf8");
    return printJson({
      event: "duet-packet-export",
      raw,
      format,
      agent,
      outPath,
      chars: rendered.length,
      sha256: textDigest(rendered),
      overBudget: packet.payload.packet.overBudget,
    });
  }
  process.stdout.write(config.asciiConsole === false ? rendered : escapeNonAscii(rendered));
}

function oneLinePreview(text, limit = 200) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function duetStepPrompt(agent, packetText) {
  if (agent === "minimax") {
    return [
      "Review only. Do not edit files. Answer with a compact Duet handoff.",
      "",
      "You are MiniMax participating in Mavis MiniMax Bridge Duet Relay.",
      "Use the packet below to review, continue reasoning, identify risks, and propose the next useful handoff.",
      "Do not claim that you executed local commands unless the packet says they were executed.",
      "Do not ask the human to approve routine continuation; escalate only for a real human decision.",
      "",
      "Start the handoff with exactly one status line: `Status: running`, `Status: done`, or `Status: human_escalation`.",
      "After the status line, include concise reasoning, findings, next steps, and any files or commands the next agent should inspect.",
      "For `Status: running`, the bridge will pass the baton back to Codex.",
      "",
      "## Duet Packet",
      "",
      packetText,
    ].join("\n");
  }
  if (agent === "codex") {
    return [
      "You are Codex participating in Mavis MiniMax Bridge Duet Relay.",
      "Continue the shared task from the packet below inside the current workspace.",
      "You may inspect and edit local files when that is the next useful step.",
      "Do not commit, push, or run destructive commands.",
      "Do not ask the human to approve routine continuation; escalate only for a real human decision.",
      "",
      "When finished, answer with a compact Duet handoff.",
      "Start the handoff with exactly one status line: `Status: running`, `Status: done`, or `Status: human_escalation`.",
      "After the status line, include concise reasoning, changed files, verifier results, next steps, and any files or commands the next agent should inspect.",
      "For `Status: running`, the bridge will pass the baton back to MiniMax.",
      "",
      "## Duet Packet",
      "",
      packetText,
    ].join("\n");
  }
  throw new Error(`unsupported duet step agent: ${agent}`);
}

function assertDuetStepPreconditions(state, agent) {
  if (state.status !== "running") {
    throw new Error(`duet step requires running status; current status is ${state.status}`);
  }
  if (state.iteration >= state.maxIterations) {
    throw new Error(`duet step refused: maxIterations reached (${state.iteration}/${state.maxIterations})`);
  }
  if (state.baton !== agent) {
    throw new Error(`duet step refused: baton is held by ${state.baton}`);
  }
}

function parseDuetStepStatus(answer) {
  const text = String(answer || "");
  const explicit = text.match(/^\s*status\s*:\s*(running|done|human_escalation)\b/im);
  if (explicit) return explicit[1].toLowerCase();
  const bare = text.match(/^\s*(running|done|human_escalation)\b/im);
  return bare ? bare[1].toLowerCase() : "running";
}

function duetStepHandoffPath(agent, suffix, ts = now()) {
  return path.join(bridgeDir, `.duet-step-${agent}-${safeFileTimestamp(ts)}.${suffix}.local.md`);
}

function fakeModelReplyFromEnv() {
  if (process.env.MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY !== "1") return null;
  if (process.env.MAVIS_BRIDGE_TEST_MODEL_REPLY === undefined) return null;
  return String(process.env.MAVIS_BRIDGE_TEST_MODEL_REPLY);
}

function publicModelTurns(turns, raw) {
  if (raw) return turns;
  return turns.map((turn) => {
    const { answer, reply, ...rest } = turn;
    return rest;
  });
}

async function runDuetReviewOnlyTurn(args, promptText, envelope) {
  const preflight = assertTaskBudget([{ taskPath: envelope.taskPath || "duet-step", text: promptText }]);
  const id = envelope.id || cryptoRandomID();
  const request = {
    event: envelope.event || "duet-step-request",
    id,
    mode: "review-only",
    chars: promptText.length,
    preflight,
    ...envelope,
  };
  appendJsonl(inboxPath, request);

  const fakeReply = fakeModelReplyFromEnv();
  if (fakeReply !== null) {
    const route = requiredModel();
    const [providerID, ...modelParts] = route.split("/");
    const turn = {
      index: 1,
      taskPath: request.taskPath || null,
      chars: promptText.length,
      providerID,
      modelID: modelParts.join("/"),
      inputTokens: estimateInputTokensForText(addOptimizationContext(promptText, { role: "main" })),
      outputTokens: estimateInputTokensForText(fakeReply),
      cacheWrite: 0,
      cacheRead: 0,
      finishReason: "test",
      truncated: false,
      outputCap: roleOutputCap("main"),
      outputCapRatio: 0,
      nearOutputCap: false,
      cacheStatus: "none",
      optimizationContext: optimizationContext({ role: "main", model: route, cacheStatus: "none" }),
      reply: fakeReply.slice(0, 200),
      answer: fakeReply.slice(-12000),
    };
    return {
      ...request,
      port: null,
      sessionID: "test-duet-step",
      signals: {
        providerMinimax: providerID === "minimax",
        agentMinimaxUrl: false,
        promptCachePatched: false,
        unauthorized: false,
        cacheWrite: 0,
        cacheRead: 0,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        unknownFinishReason: 0,
        truncated: 0,
      },
      turns: [turn],
      answer: fakeReply,
      provider: providerID,
      role: "main",
      model: route,
      entries: [normalizedTurnEntry(turn, { model: route }, { role: "main" })],
    };
  }

  const server = await selectServer(args);
  const session = await createSession(server.port, `bridge-duet-step-${Date.now()}`);
  const timeoutSec = config.maxWallClockSec || 180;
  const result = await sendPrompt(server.port, session.id, promptText, {
    timeoutSec,
    role: "main",
  });
  const answer = assistantText(result);
  const summary = turnSummary(result, { role: "main" });
  const turn = {
    index: 1,
    taskPath: request.taskPath || null,
    chars: promptText.length,
    ...summary,
    answer: answer.slice(-12000),
  };
  const signals = extractSignalsFromMessages([result]);
  return {
    ...request,
    port: server.port,
    sessionID: session.id,
    signals,
    turns: [turn],
    answer,
    provider: turn.providerID || "minimax",
    role: "main",
    model: parseModelRef(turn.providerID, turn.modelID) || requiredModel(),
    entries: [normalizedTurnEntry(turn, server.config, { role: "main" })],
  };
}

function parseCodexJsonEvents(text) {
  const events = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (_) {
      // Codex can mix diagnostics into --json output; keep parsing tolerant.
    }
  }
  return events;
}

function lastCodexUsage(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = events[index]?.usage;
    if (usage && typeof usage === "object") return usage;
  }
  return null;
}

function terminateChildProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
}

function codexPromptPathForOutput(outputPath) {
  return outputPath.replace(/\.pending\.local\.md$/i, ".prompt.local.txt");
}

async function runCodexExecTurn(promptText, envelope, outputPath) {
  const preflight = assertTaskBudget([{ taskPath: envelope.taskPath || "duet-step", text: promptText }]);
  const id = envelope.id || cryptoRandomID();
  const request = {
    event: envelope.event || "duet-step-request",
    id,
    mode: "exec",
    chars: promptText.length,
    preflight,
    ...envelope,
  };
  appendJsonl(inboxPath, request);

  const fakeReply = fakeModelReplyFromEnv();
  if (fakeReply !== null) {
    return {
      ...request,
      exitCode: 0,
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      usage: {
        input_tokens: estimateInputTokensForText(promptText),
        cached_input_tokens: 0,
        output_tokens: estimateInputTokensForText(fakeReply),
      },
      answer: fakeReply,
      provider: "openai",
      role: "codex",
      model: "codex-cli:test",
      entries: [],
    };
  }

  const cli = String(config.codexCli || "codex").trim();
  const timeoutSec = config.codexStepTimeoutSec || config.maxWallClockSec || 180;
  const codexArgs = [
    "exec",
    "--cd",
    bridgeDir,
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--output-last-message",
    outputPath,
    "-",
  ];

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let promptPath = null;
    let spawnFile = cli;
    let spawnArgs = codexArgs;
    if (process.platform === "win32") {
      promptPath = codexPromptPathForOutput(outputPath);
      fs.writeFileSync(promptPath, promptText, "utf8");
      spawnFile = "powershell.exe";
      spawnArgs = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(bridgeDir, "scripts", "run-codex-exec.ps1"),
        "-CodexCli",
        cli,
        "-Workspace",
        bridgeDir,
        "-OutputLastMessage",
        outputPath,
        "-PromptPath",
        promptPath,
      ];
    }
    const child = spawn(spawnFile, spawnArgs, {
      cwd: bridgeDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      settled = true;
      terminateChildProcessTree(child);
      reject(new Error(`codex exec timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > verifierMaxStreamBytes) stdout = stdout.slice(-verifierMaxStreamBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > verifierMaxStreamBytes) stderr = stderr.slice(-verifierMaxStreamBytes);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (promptPath) fs.rmSync(promptPath, { force: true });
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (promptPath) fs.rmSync(promptPath, { force: true });
      const events = parseCodexJsonEvents(stdout);
      const usage = lastCodexUsage(events);
      if (code !== 0) {
        const detail = oneLinePreview(`${stderr}\n${stdout}`, 500);
        reject(new Error(`codex exec exited ${code}: ${detail}`));
        return;
      }
      if (!fs.existsSync(outputPath)) {
        reject(new Error("codex exec exited 0 but did not write --output-last-message"));
        return;
      }
      const answer = fs.readFileSync(outputPath, "utf8");
      resolve({
        ...request,
        exitCode: code,
        timedOut: false,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        usage,
        answer,
        provider: "openai",
        role: "codex",
        model: "codex-cli",
        entries: [],
        diagnostics: {
          jsonEvents: events.length,
          stderrSha256: stderr ? textDigest(stderr) : null,
        },
      });
    });
    child.stdin.end(process.platform === "win32" ? "" : promptText);
  });
}

function duetStepDryRun(args) {
  const raw = args.includes("--raw");
  if (!args.includes("--dry-run")) {
    if (args.includes("--yes")) throw new Error("duet step --yes requires the live step path; do not combine it with --dry-run");
    throw new Error("duet step requires --dry-run or --yes");
  }
  const agent = requireDuetAgent(argValue(args, "--agent"), "--agent");
  const state = readDuetState();
  readDuetJournal();
  assertDuetStepPreconditions(state, agent);
  const configuredMax = Number(config.duetPacketMaxChars || 60000);
  const maxPacketChars = positiveIntegerArg(args, "--max-packet-chars", String(configuredMax));
  const maxLongPromptChars = Number(config.maxLongPromptChars || 160000);
  if (maxPacketChars > maxLongPromptChars) {
    throw new Error(`--max-packet-chars must be <= maxLongPromptChars=${maxLongPromptChars}`);
  }
  const rawPacket = createBoundedDuetPacket(agent, true, "markdown", maxPacketChars);
  const redactedPacket = createBoundedDuetPacket(agent, false, "json", maxPacketChars);
  const promptText = duetStepPrompt(agent, rawPacket.rendered);
  const promptForEstimate = agent === "minimax" ? addOptimizationContext(promptText, { role: "main" }) : promptText;
  const estimatedInputTokens = estimateInputTokensForText(promptForEstimate);
  const maxInputTokens = Number(config.maxInputTokens || 200000);
  const route = agent === "minimax" ? requiredModel() : "codex-cli";
  const dryRunWarnings = state.lastHandoff ? [] : ["missing_last_handoff"];
  const packetDetails = raw
    ? {
      maxChars: maxPacketChars,
      rawChars: rawPacket.rendered.length,
      rawSha256: textDigest(rawPacket.rendered),
      rawOverBudget: rawPacket.payload.packet.overBudget,
      redactedChars: redactedPacket.rendered.length,
      redactedSha256: textDigest(redactedPacket.rendered),
      redactedPreview: oneLinePreview(redactedPacket.rendered),
    }
    : {
      maxChars: maxPacketChars,
      redactedChars: redactedPacket.rendered.length,
      redactedSha256: textDigest(redactedPacket.rendered),
      redactedPreview: oneLinePreview(redactedPacket.rendered),
    };
  const promptDetails = raw
    ? {
      chars: promptText.length,
      sha256: textDigest(promptText),
      estimatedInputTokens,
      maxInputTokens,
      withinBudget: estimatedInputTokens <= maxInputTokens,
      text: promptText,
    }
    : {
      estimatedInputTokens,
      maxInputTokens,
      withinBudget: estimatedInputTokens <= maxInputTokens,
    };
  printJson({
    event: "duet-step-dry-run",
    agent,
    mode: agent === "minimax" ? "review-only" : "exec",
    tokenSpending: false,
    wouldCallModel: true,
    liveCallAllowed: estimatedInputTokens <= maxInputTokens,
    raw,
    warning: dryRunWarnings[0] || null,
    warnings: dryRunWarnings,
    route: {
      provider: agent === "minimax" ? providerFromModel(route) : "openai",
      model: route,
      outputCapTokens: agent === "minimax" ? roleOutputCap("main") : null,
      cli: agent === "codex" ? config.codexCli : undefined,
      sandbox: agent === "codex" ? "workspace-write" : undefined,
      timeoutSec: agent === "codex" ? config.codexStepTimeoutSec : undefined,
    },
    packet: packetDetails,
    prompt: promptDetails,
    state: publicDuetState(state),
  });
}

async function duetStepLive(args) {
  const raw = args.includes("--raw");
  if (!args.includes("--yes")) throw new Error("duet step requires --dry-run or --yes");
  if (args.includes("--dry-run")) throw new Error("duet step accepts either --dry-run or --yes, not both");
  if (args.includes("--force")) throw new Error("duet step does not support --force");
  requireSpendingApproval(args, "duet step");
  const agent = requireDuetAgent(argValue(args, "--agent"), "--agent");
  const stateBefore = readDuetState();
  const stateBeforeText = fs.readFileSync(duetStatePath, "utf8");
  const journalBeforeText = readDuetJournal();
  assertDuetStepPreconditions(stateBefore, agent);
  const configuredMax = Number(config.duetPacketMaxChars || 60000);
  const maxPacketChars = positiveIntegerArg(args, "--max-packet-chars", String(configuredMax));
  const maxLongPromptChars = Number(config.maxLongPromptChars || 160000);
  if (maxPacketChars > maxLongPromptChars) {
    throw new Error(`--max-packet-chars must be <= maxLongPromptChars=${maxLongPromptChars}`);
  }

  const rawPacket = createBoundedDuetPacket(agent, true, "markdown", maxPacketChars);
  const promptText = duetStepPrompt(agent, rawPacket.rendered);
  const ts = now();
  const pendingPath = duetStepHandoffPath(agent, "pending", ts);
  const appliedPath = duetStepHandoffPath(agent, "applied", ts);
  const envelope = {
    event: "duet-step-request",
    agent,
    taskPath: `duet-step:${agent}`,
    packet: {
      maxChars: maxPacketChars,
      rawChars: rawPacket.rendered.length,
      rawSha256: textDigest(rawPacket.rendered),
      rawOverBudget: rawPacket.payload.packet.overBudget,
    },
  };
  const modelRun = agent === "minimax"
    ? await runDuetReviewOnlyTurn(args, promptText, envelope)
    : await runCodexExecTurn(promptText, envelope, pendingPath);

  const answer = modelRun.answer || "";
  const status = parseDuetStepStatus(answer);
  if (agent === "minimax" || !fs.existsSync(pendingPath) || !answer.trim()) {
    const fallbackAgent = agent === "minimax" ? "MiniMax" : "Codex";
    fs.writeFileSync(pendingPath, answer.trim() || `Status: running\n\n${fallbackAgent} returned an empty handoff.`, "utf8");
  }

  const stepEventBase = {
    event: "duet-step",
    id: modelRun.id,
    agent,
    mode: agent === "minimax" ? "review-only" : "exec",
    tokenSpending: true,
    sessionID: modelRun.sessionID,
    port: modelRun.port,
    provider: modelRun.provider,
    role: modelRun.role,
    model: modelRun.model,
    status,
    pendingPath,
    turns: publicModelTurns(modelRun.turns || [], raw),
    entries: modelRun.entries,
    signals: modelRun.signals,
    usage: modelRun.usage,
    diagnostics: raw ? modelRun.diagnostics : undefined,
    packet: raw ? {
      maxChars: maxPacketChars,
      rawChars: rawPacket.rendered.length,
      rawSha256: textDigest(rawPacket.rendered),
      rawOverBudget: rawPacket.payload.packet.overBudget,
    } : {
      maxChars: maxPacketChars,
      rawOverBudget: rawPacket.payload.packet.overBudget,
    },
  };

  let passResult = null;
  try {
    const passArgs = status === "running"
      ? ["--from", agent, "--to", nextDuetAgent(agent), "--handoff", pendingPath]
      : ["--from", agent, "--status", status, "--handoff", pendingPath];
    passResult = duetPassCommand(passArgs, { print: false });
  } catch (error) {
    writeTextAtomic(duetStatePath, stateBeforeText);
    writeTextAtomic(duetJournalPath, journalBeforeText);
    const out = {
      ...stepEventBase,
      applyStatus: "apply_failed",
      error: error.message,
      answer: raw ? answer : undefined,
      answerSummary: textSummary(answer),
      state: publicDuetState(stateBefore),
    };
    appendJsonl(ledgerPath, out);
    appendJsonl(outboxPath, out);
    printJson(out);
    process.exitCode = 1;
    return;
  }

  let finalAppliedPath = appliedPath;
  let renameWarning = null;
  try {
    fs.renameSync(pendingPath, appliedPath);
  } catch (error) {
    finalAppliedPath = null;
    renameWarning = `handoff applied but pending file was not renamed: ${error.message}`;
  }
  {
    const out = {
      ...stepEventBase,
      applyStatus: "applied",
      appliedPath: finalAppliedPath,
      pendingPath: finalAppliedPath ? null : pendingPath,
      warning: renameWarning,
      answer: raw ? answer : undefined,
      answerSummary: textSummary(answer),
      state: publicDuetState(passResult.state),
    };
    appendJsonl(ledgerPath, out);
    appendJsonl(outboxPath, out);
    printJson(out);
  }
}

function duetLoopDryRun(args) {
  if (!args.includes("--dry-run")) {
    if (args.includes("--yes")) throw new Error("duet loop --yes is not implemented yet; use --dry-run for Phase 5C preflight");
    throw new Error("duet loop requires --dry-run in Phase 5C");
  }
  if (args.includes("--yes")) throw new Error("duet loop accepts either --dry-run or --yes, not both");
  if (args.includes("--force")) throw new Error("duet loop does not support --force");

  const parsed = verifierArgs(args);
  const options = parsed.options;
  const raw = options.includes("--raw");
  const state = readDuetState();
  const journal = readDuetJournal();
  const configuredMax = Number(config.duetPacketMaxChars || 60000);
  const maxPacketChars = positiveIntegerArg(options, "--max-packet-chars", String(configuredMax));
  const maxLongPromptChars = Number(config.maxLongPromptChars || 160000);
  if (maxPacketChars > maxLongPromptChars) {
    throw new Error(`--max-packet-chars must be <= maxLongPromptChars=${maxLongPromptChars}`);
  }

  const maxRounds = positiveIntegerArg(options, "--max-rounds", "8");
  const maxCodexSteps = positiveIntegerArg(options, "--max-codex-steps", String(maxRounds));
  const maxMiniMaxSteps = positiveIntegerArg(options, "--max-minimax-steps", String(maxRounds));
  const maxTokens = positiveIntegerArg(options, "--max-tokens", "60000");
  const verifierPathArg = argValue(options, "--verifier", null);
  const verifier = verifierPathArg
    ? {
      path: resolveVerifierPath(verifierPathArg),
      args: parsed.forwarded,
    }
    : null;

  const warnings = [];
  const stopReasons = [];
  let nextStep = null;
  if (state.status !== "running") {
    stopReasons.push(`terminal_status:${state.status}`);
  }
  if (state.iteration > maxRounds) {
    stopReasons.push(`max_rounds:${state.iteration}/${maxRounds}`);
  }
  if (state.status === "running" && !state.baton) {
    stopReasons.push("missing_baton");
  }
  if (!state.lastHandoff) warnings.push("missing_last_handoff");

  if (stopReasons.length === 0) {
    const agent = requireDuetAgent(state.baton, "state.baton");
    const rawPacket = createBoundedDuetPacket(agent, true, "markdown", maxPacketChars);
    const redactedPacket = createBoundedDuetPacket(agent, false, "json", maxPacketChars);
    const promptText = duetStepPrompt(agent, rawPacket.rendered);
    const promptForEstimate = agent === "minimax" ? addOptimizationContext(promptText, { role: "main" }) : promptText;
    const estimatedInputTokens = estimateInputTokensForText(promptForEstimate);
    if (estimatedInputTokens > maxTokens) stopReasons.push(`token_budget:${estimatedInputTokens}/${maxTokens}`);
    if (agent === "codex" && maxCodexSteps < 1) stopReasons.push("max_codex_steps:0");
    if (agent === "minimax" && maxMiniMaxSteps < 1) stopReasons.push("max_minimax_steps:0");
    nextStep = {
      agent,
      command: `node .\\bridge.mjs duet step --agent ${agent} --yes`,
      mode: agent === "minimax" ? "review-only" : "exec",
      tokenSpending: true,
      estimatedInputTokens,
      withinTokenBudget: estimatedInputTokens <= maxTokens,
      packet: raw
        ? {
          maxChars: maxPacketChars,
          rawChars: rawPacket.rendered.length,
          rawSha256: textDigest(rawPacket.rendered),
          rawOverBudget: rawPacket.payload.packet.overBudget,
          redactedChars: redactedPacket.rendered.length,
          redactedSha256: textDigest(redactedPacket.rendered),
        }
        : {
          maxChars: maxPacketChars,
          redactedChars: redactedPacket.rendered.length,
          redactedSha256: textDigest(redactedPacket.rendered),
          rawOverBudget: rawPacket.payload.packet.overBudget,
        },
      route: agent === "minimax"
        ? { provider: providerFromModel(requiredModel()), model: requiredModel(), outputCapTokens: roleOutputCap("main") }
        : { provider: "openai", model: "codex-cli", cli: config.codexCli, sandbox: "workspace-write", timeoutSec: config.codexStepTimeoutSec },
    };
  }

  printJson({
    event: "duet-loop-dry-run",
    mode: "preflight",
    tokenSpending: false,
    wouldRunLoop: stopReasons.length === 0,
    wouldCallAgent: stopReasons.length === 0,
    stopReasons,
    warning: warnings[0] || null,
    warnings,
    limits: {
      maxRounds,
      maxCodexSteps,
      maxMiniMaxSteps,
      maxTokens,
      maxPacketChars,
    },
    verifier: verifier
      ? {
        path: verifier.path,
        args: verifier.args,
      }
      : null,
    nextStep,
    lastVerifier: lastDuetVerifierSummary(journal),
    state: raw ? state : publicDuetState(state),
  });
}

function appendDuetJournal(markdown) {
  readDuetJournal();
  fs.appendFileSync(duetJournalPath, `\n${markdown.trim()}\n`, "utf8");
}

function verifierArgs(args) {
  const separator = args.indexOf("--");
  return {
    options: separator >= 0 ? args.slice(0, separator) : args,
    forwarded: separator >= 0 ? args.slice(separator + 1) : [],
  };
}

function validateForwardedVerifierArgs(args) {
  if (args.length > verifierMaxArgs) {
    throw new Error(`too many verifier args: ${args.length} > ${verifierMaxArgs}`);
  }
  for (const value of args) {
    if (String(value).includes("\0")) throw new Error("verifier args must not contain NUL bytes");
    const bytes = Buffer.byteLength(String(value), "utf8");
    if (bytes > verifierMaxArgBytes) {
      throw new Error(`verifier arg too large: ${bytes} bytes > ${verifierMaxArgBytes}`);
    }
  }
}

function resolveVerifierPath(verifierPath) {
  if (!verifierPath) throw new Error("--verifier is required");
  if (String(verifierPath).includes("\0")) throw new Error("--verifier must not contain NUL bytes");
  const resolved = path.resolve(process.cwd(), verifierPath);
  if (!fs.existsSync(resolved)) throw new Error(`verifier file not found: ${resolved}`);
  const realPath = realpathOrResolve(resolved);
  if (!isPathInsideRoot(bridgeDir, realPath)) {
    throw new Error(`verifier path escapes bridge root: ${resolved}`);
  }
  const ext = path.extname(realPath).toLowerCase();
  if (![".js", ".mjs", ".cjs"].includes(ext)) {
    throw new Error("--verifier must be a .js, .mjs, or .cjs file");
  }
  const stats = fs.statSync(realPath);
  if (!stats.isFile()) throw new Error(`verifier is not a regular file: ${realPath}`);
  if (stats.size > verifierMaxBytes) {
    throw new Error(`verifier file too large: ${stats.size} bytes > ${verifierMaxBytes}`);
  }
  return { path: realPath, basename: path.basename(realPath), bytes: stats.size };
}

function verifierEnv() {
  const allow = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "ComSpec",
    "LANG",
    "LC_ALL",
  ];
  const env = {};
  for (const key of allow) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = "";
  env.USERPROFILE = "";
  env.NODE_OPTIONS = "";
  return env;
}

function summarizeStream(buffer, raw, totalBytes = buffer.length) {
  const text = buffer.toString("utf8");
  const truncated = totalBytes > verifierMaxStreamBytes || buffer.length > verifierMaxStreamBytes;
  const capped = truncated ? text.slice(0, verifierMaxStreamBytes) : text;
  if (raw) {
    return {
      mode: "raw",
      bytes: totalBytes,
      lines: capped ? capped.split(/\r?\n/).length : 0,
      sha256: textDigest(capped),
      truncated,
      text: capped,
    };
  }
  const head = capped.slice(0, 4096);
  const tail = capped.length > 4096 ? capped.slice(-4096) : capped;
  return {
    mode: "redacted",
    bytes: totalBytes,
    lines: capped ? capped.split(/\r?\n/).length : 0,
    sha256: textDigest(capped),
    truncated,
    head: textSummary(head),
    tail: textSummary(tail),
  };
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { encoding: "utf8" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (_) {
    // Process may have exited between timeout and kill.
  }
}

function runVerifierProcess(verifier, forwarded, timeoutSec, raw) {
  return new Promise((resolve) => {
    const startedAt = now();
    const startedMs = Date.now();
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-verify-"));
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutStoredBytes = 0;
    let stderrStoredBytes = 0;
    let timedOut = false;
    let spawnError = null;

    const child = spawn(process.execPath, [verifier.path, ...forwarded], {
      cwd: scratchDir,
      env: verifierEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutSec * 1000);

    const capture = (chunks, type) => (chunk) => {
      const nextBytes = type === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (type === "stdout") stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
      let storedBytes = type === "stdout" ? stdoutStoredBytes : stderrStoredBytes;
      if (storedBytes >= verifierMaxStreamBytes + 1) return;
      const remaining = verifierMaxStreamBytes + 1 - storedBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      storedBytes += slice.length;
      if (type === "stdout") stdoutStoredBytes = storedBytes;
      else stderrStoredBytes = storedBytes;
    };

    child.stdout.on("data", capture(stdoutChunks, "stdout"));
    child.stderr.on("data", capture(stderrChunks, "stderr"));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      const endedAt = now();
      const status = spawnError
        ? "spawn_error"
        : timedOut
          ? "timeout"
          : code === 0
            ? "ok"
            : "fail";
      resolve({
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        status,
        exitCode: timedOut || spawnError ? null : code,
        signal: timedOut ? "timeout" : signal || null,
        error: spawnError ? spawnError.message : null,
        stdout: summarizeStream(stdoutBuffer, raw, stdoutBytes),
        stderr: summarizeStream(stderrBuffer, raw, stderrBytes),
        truncated: stdoutBytes > verifierMaxStreamBytes || stderrBytes > verifierMaxStreamBytes,
      });
    });
  });
}

function appendVerifyJournalEntry(agent, result) {
  return withDuetLock(() => {
    const state = readDuetState();
    if (state.status !== "running") {
      throw new Error(`cannot record verify result when duet status is ${state.status}`);
    }
    readDuetJournal();
    const shortHash = result.verifier.sha256.slice(0, 8);
    const note = `## Verify - ${agent} - ${result.endedAt}\n\nstatus=${result.status} exit=${result.exitCode ?? "null"} durationMs=${result.durationMs} verifier=${result.verifier.basename} sha=${shortHash}`;
    appendDuetJournal(note);
    state.updatedAt = now();
    writeDuetState(state);
    return { appended: true, agent, note: note.replace(/\r?\n/g, " ") };
  });
}

async function duetVerifyCommand(args) {
  const { options, forwarded } = verifierArgs(args);
  const raw = options.includes("--raw");
  const record = options.includes("--record");
  const agent = argValue(options, "--agent", null);
  if (record && raw) throw new Error("--raw cannot be combined with --record");
  if (record) requireDuetAgent(agent, "--agent");
  validateForwardedVerifierArgs(forwarded);
  const timeoutSec = positiveIntegerArg(options, "--timeout-sec", "60");
  if (timeoutSec > 600) throw new Error("--timeout-sec must be <= 600");
  const verifier = resolveVerifierPath(argValue(options, "--verifier"));
  const verifierBytes = fs.readFileSync(verifier.path);
  const run = await runVerifierProcess(verifier, forwarded, timeoutSec, raw);
  const result = {
    event: "duet-verify",
    raw,
    redacted: !raw,
    verifier: {
      basename: verifier.basename,
      bytes: verifier.bytes,
      sha256: createHash("sha256").update(verifierBytes).digest("hex"),
    },
    timeoutSec,
    args: forwarded,
    ...run,
    warning: raw ? "raw output contains verifier stdout/stderr up to the stream cap" : null,
    record: null,
  };
  if (record) {
    result.record = appendVerifyJournalEntry(agent, result);
  }
  printJson(result);
}

function nextDuetAgent(agent) {
  return agent === "codex" ? "minimax" : "codex";
}

function positiveIntegerArg(args, name, fallback) {
  const raw = argValue(args, name, fallback);
  const value = Number(raw);
  return requireDuetPositiveInteger(value, name);
}

function withDuetLock(callback) {
  let handle = null;
  try {
    if (fs.existsSync(duetLockPath)) {
      const stats = fs.statSync(duetLockPath);
      if (Date.now() - stats.mtimeMs > duetLockStaleMs) {
        fs.unlinkSync(duetLockPath);
      }
    }
    handle = fs.openSync(duetLockPath, "wx");
    fs.writeFileSync(handle, stableStringify({ pid: process.pid, createdAt: now() }), "utf8");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("duet lock is held by another command; retry after it finishes");
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    if (handle !== null) fs.closeSync(handle);
    try {
      fs.unlinkSync(duetLockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function withDuetLockAsync(callback) {
  let handle = null;
  let heartbeat = null;
  try {
    if (fs.existsSync(duetLockPath)) {
      const stats = fs.statSync(duetLockPath);
      if (Date.now() - stats.mtimeMs > duetLockStaleMs) {
        fs.unlinkSync(duetLockPath);
      }
    }
    handle = fs.openSync(duetLockPath, "wx");
    fs.writeFileSync(handle, stableStringify({ pid: process.pid, createdAt: now(), async: true }), "utf8");
    heartbeat = setInterval(() => {
      try {
        const time = new Date();
        fs.utimesSync(duetLockPath, time, time);
      } catch (_) {
        // Best-effort heartbeat; final unlink still owns cleanup.
      }
    }, Math.min(30000, Math.max(1000, Math.floor(duetLockStaleMs / 4))));
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("duet lock is held by another command; retry after it finishes");
    }
    throw error;
  }
  try {
    return await callback();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (handle !== null) fs.closeSync(handle);
    try {
      fs.unlinkSync(duetLockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function duetInitCommand(args) {
  if ((fs.existsSync(duetStatePath) || fs.existsSync(duetJournalPath)) && !args.includes("--force")) {
    throw new Error("duet state already exists; use --force to reinitialize");
  }
  const goal = readRequiredText(argValue(args, "--goal"), "--goal", duetMaxEntryChars);
  const baton = requireDuetAgent(argValue(args, "--baton", "codex"), "--baton");
  const maxIterations = positiveIntegerArg(args, "--max-iterations", "12");
  const ts = now();
  const state = {
    goal,
    baton,
    iteration: 1,
    maxIterations,
    status: "running",
    lastHandoff: "",
    humanEscalation: null,
    createdAt: ts,
    updatedAt: ts,
  };
  writeDuetState(state);
  fs.writeFileSync(
    duetJournalPath,
    `# Duet Journal\n\n## Goal\n\n${goal}\n\n## Current State\n\nBaton: ${baton}\nStatus: running\n\n## Decisions\n\n## Done\n\n## Open Questions\n\n## Last Handoff\n`,
    "utf8",
  );
  appendJsonl(ledgerPath, { event: "duet-init", baton, maxIterations });
  printDuetEvent("duet-init", state, args);
}

function duetShowCommand(args) {
  const state = readDuetState();
  const journal = readDuetJournal();
  const extra = args.includes("--raw")
    ? { journalTail: journal.trim().split(/\r?\n/).slice(-80).join("\n") }
    : { journal: textSummary(journal) };
  printDuetEvent("duet-show", state, args, extra);
}

function duetPassCommand(args, options = {}) {
  const state = readDuetState();
  const from = requireDuetAgent(argValue(args, "--from"), "--from");
  if (state.status !== "running" && !args.includes("--force")) {
    throw new Error(`duet status is ${state.status}; use --force to append anyway`);
  }
  if (state.baton !== from && !args.includes("--force")) {
    throw new Error(`baton is held by ${state.baton}; use --force to override`);
  }
  const status = requireDuetStatus(argValue(args, "--status", "running"));
  const to = status === "running"
    ? requireDuetAgent(argValue(args, "--to", nextDuetAgent(from)), "--to")
    : argValue(args, "--to", null);
  if (to) requireDuetAgent(to, "--to");

  const handoff = readDuetHandoffText(argValue(args, "--handoff"));
  let nextIteration = state.iteration;
  let nextStatus = status;
  let humanEscalation = status === "human_escalation" ? handoff : state.humanEscalation;
  let baton = status === "running" ? to : null;
  if (status === "running") {
    if (state.iteration >= state.maxIterations) {
      nextStatus = "human_escalation";
      humanEscalation = `maxIterations reached (${state.maxIterations})`;
      baton = null;
    } else {
      nextIteration = state.iteration + 1;
    }
  }

  const ts = now();
  appendDuetJournal(`## Turn ${state.iteration} - ${from}${baton ? ` -> ${baton}` : ""} - ${ts}\n\nStatus: ${nextStatus}\n\n${handoff}`);
  const nextState = {
    ...state,
    baton,
    iteration: nextIteration,
    status: nextStatus,
    lastHandoff: truncateDuetText(handoff),
    humanEscalation,
    updatedAt: ts,
  };
  writeDuetState(nextState);
  appendJsonl(ledgerPath, { event: "duet-pass", from, to: baton, status: nextStatus, iteration: nextState.iteration });
  if (options.print !== false) printDuetEvent("duet-pass", nextState, args);
  return { event: "duet-pass", state: nextState };
}

function duetNoteCommand(args) {
  const state = readDuetState();
  const agent = requireDuetAgent(argValue(args, "--agent"), "--agent");
  const note = readRequiredText(argValue(args, "--note"), "--note", duetMaxEntryChars);
  const ts = now();
  appendDuetJournal(`## Note - ${agent} - ${ts}\n\n${note}`);
  state.updatedAt = ts;
  writeDuetState(state);
  appendJsonl(ledgerPath, { event: "duet-note", agent, iteration: state.iteration });
  printDuetEvent("duet-note", state, args);
}

async function duetCommand(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log(`Usage:
  node .\\bridge.mjs duet init --goal <file> [--baton codex|minimax] [--max-iterations <n>] [--force] [--raw]
  node .\\bridge.mjs duet show [--raw]
  node .\\bridge.mjs duet next [--agent codex|minimax] [--raw]
  node .\\bridge.mjs duet packet export --agent minimax [--format json|markdown] [--out <file>] [--raw] [--max-packet-chars <n>]
  node .\\bridge.mjs duet step --agent codex|minimax --dry-run|--yes [--raw] [--max-packet-chars <n>] [--port <port>]
  node .\\bridge.mjs duet loop --dry-run [--max-rounds <n>] [--max-codex-steps <n>] [--max-minimax-steps <n>] [--max-tokens <n>] [--verifier <file>] [-- <verifier-args>...]
  node .\\bridge.mjs duet transcript export [--format json|markdown] [--out <file>] [--raw] [--include-ledger]
  node .\\bridge.mjs duet verify --verifier <file.js|file.mjs|file.cjs> [--timeout-sec <n>] [--raw] [--record --agent codex|minimax] [-- <verifier-args>...]
  node .\\bridge.mjs duet pass --from codex|minimax [--to codex|minimax] --handoff <file> [--status running|done|human_escalation] [--force] [--raw]
  node .\\bridge.mjs duet note --agent codex|minimax --note <file> [--raw]`);
    return;
  }
  if (subcommand === "init") return withDuetLock(() => duetInitCommand(rest));
  if (subcommand === "show") return duetShowCommand(rest);
  if (subcommand === "next") return duetNextCommand(rest);
  if (subcommand === "packet") return duetPacketExport(rest);
  if (subcommand === "step") {
    if (rest.includes("--dry-run")) return duetStepDryRun(rest);
    return await withDuetLockAsync(() => duetStepLive(rest));
  }
  if (subcommand === "loop") return duetLoopDryRun(rest);
  if (subcommand === "transcript") {
    const [action, ...actionRest] = rest;
    if (action === "export") return duetTranscriptExport(actionRest);
    throw new Error("unknown duet transcript command; expected `duet transcript export`");
  }
  if (subcommand === "verify") return await duetVerifyCommand(rest);
  if (subcommand === "pass") return withDuetLock(() => duetPassCommand(rest));
  if (subcommand === "note") return withDuetLock(() => duetNoteCommand(rest));
  throw new Error(`unknown duet command: ${subcommand}`);
}

async function stopCommand() {
  console.log("Bridge has no daemon process. Stop opencode serve from MiniMax Code or restart it explicitly if needed.");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!command || command === "help" || command === "--help") return usage();
    if (command === "doctor") return doctorCommand();
    ensureWorkspaceRoot(command, args);
    if (command === "status") return await statusCommand();
    if (command === "state") return await stateCommand();
    if (command === "config") return configCommand(args);
    if (command === "mode") return modeCommand(args);
    if (command === "session") return sessionCommand(args);
    if (command === "deny-session") return denySessionCommand(args);
    if (command === "token-stats") return tokenStatsCommand(args);
    if (command === "audit") return await auditCommand(args);
    if (command === "canary-estimate") return canaryEstimateCommand(args);
    if (command === "canary") return await canaryCommand(args);
    if (command === "optimize-check") return await optimizeCheckCommand(args);
    if (command === "ask") return await askCommand(args);
    if (command === "mvs-status") return await mvsStatusCommand(args);
    if (command === "mvs-peers") return await mvsPeersCommand(args);
    if (command === "mvs-messages") return await mvsMessagesCommand(args);
    if (command === "mvs-send") return await mvsSendCommand(args);
    if (command === "duet") return await duetCommand(args);
    if (command === "tail") return tailCommand(args);
    if (command === "stop") return await stopCommand();
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    if (!error.skipLedger) {
      appendJsonl(ledgerPath, { event: "error", command, message: error.message });
    }
    console.error(`[bridge] ${error.message}`);
    if (error.details && args.includes("--json")) {
      printJson({ event: "workspace-guard", ...error.details });
    }
    process.exitCode = 1;
  }
}

main();
