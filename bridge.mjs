#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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

const config = normalizeConfig(readJson(configPath, {}));

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
  node .\\bridge.mjs ask --yes --mode review-only --task <file> [--task <followup-file> ...] [--port <port>]
  node .\\bridge.mjs mvs-status [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-peers [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-messages [--session <mvs-id>] [--limit <n>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-send --task <file> --yes [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs mvs-send --content <text> --allow-inline-content --yes [--session <mvs-id>] [--daemon-port <port>]
  node .\\bridge.mjs duet init --goal <file> [--baton codex|minimax] [--max-iterations <n>] [--force] [--raw]
  node .\\bridge.mjs duet show [--raw]
  node .\\bridge.mjs duet pass --from codex|minimax [--to codex|minimax] --handoff <file> [--status running|done|human_escalation] [--force] [--raw]
  node .\\bridge.mjs duet note --agent codex|minimax --note <file> [--raw]
  node .\\bridge.mjs tail [--lines <n>] [--raw]
  node .\\bridge.mjs stop`);
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
  if (typeof configObject.defaultModel !== "string" || !configObject.defaultModel.trim()) {
    throw new Error("defaultModel must be a non-empty string");
  }
  if (typeof configObject.requireModel !== "string" || !configObject.requireModel.trim()) {
    throw new Error("requireModel must be a non-empty string");
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
  requireSpendingApproval(args, "ask");
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
  const preflight = assertTaskBudget(tasks);
  const server = await selectServer(args);
  const envelope = {
    event: "ask",
    id: cryptoRandomID(),
    mode,
    port: server.port,
    taskPath: tasks[0].taskPath,
    taskPaths: tasks.map((task) => task.taskPath),
    turnsRequested: tasks.length,
    chars: tasks.reduce((sum, task) => sum + task.text.length, 0),
    preflight,
  };
  appendJsonl(inboxPath, envelope);

  const session = await createSession(server.port, `bridge-ask-${Date.now()}`);
  const results = [];
  const turns = [];
  const timeoutSec = config.maxWallClockSec || 180;
  let lastResponseTruncated = false;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const prompt = mode === "review-only"
      ? `Review only. Do not edit files. Answer concisely.\n\n${task.text}`
      : `Propose a unified diff only. Do not apply it.\n\n${task.text}`;
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
      chars: task.text.length,
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

function appendDuetJournal(markdown) {
  readDuetJournal();
  fs.appendFileSync(duetJournalPath, `\n${markdown.trim()}\n`, "utf8");
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

function duetPassCommand(args) {
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

  const handoff = readRequiredText(argValue(args, "--handoff"), "--handoff", duetMaxEntryChars);
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
  printDuetEvent("duet-pass", nextState, args);
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

function duetCommand(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log(`Usage:
  node .\\bridge.mjs duet init --goal <file> [--baton codex|minimax] [--max-iterations <n>] [--force] [--raw]
  node .\\bridge.mjs duet show [--raw]
  node .\\bridge.mjs duet pass --from codex|minimax [--to codex|minimax] --handoff <file> [--status running|done|human_escalation] [--force] [--raw]
  node .\\bridge.mjs duet note --agent codex|minimax --note <file> [--raw]`);
    return;
  }
  if (subcommand === "init") return withDuetLock(() => duetInitCommand(rest));
  if (subcommand === "show") return duetShowCommand(rest);
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
    if (command === "duet") return duetCommand(args);
    if (command === "tail") return tailCommand(args);
    if (command === "stop") return await stopCommand();
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    appendJsonl(ledgerPath, { event: "error", command, message: error.message });
    console.error(`[bridge] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
