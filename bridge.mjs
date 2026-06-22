#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const bridgeDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const configPath = path.join(bridgeDir, "config.json");
const inboxPath = path.join(bridgeDir, "inbox.jsonl");
const outboxPath = path.join(bridgeDir, "outbox.jsonl");
const ledgerPath = path.join(bridgeDir, "ledger.jsonl");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

const config = readJson(configPath, {});

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
  node bridge/bridge.mjs status
  node bridge/bridge.mjs canary-estimate [--long-prompt <file>] [--repeat-long <n>]
  node bridge/bridge.mjs canary [--port <port>]
  node bridge/bridge.mjs optimize-check [--session <mvs-id>] [--port <port>] [--skip-canary] [--long-prompt <file>] [--repeat-long <n>]
  node bridge/bridge.mjs ask --mode review-only --task <file> [--port <port>]
  node bridge/bridge.mjs mvs-status [--session <mvs-id>] [--daemon-port <port>]
  node bridge/bridge.mjs mvs-peers [--session <mvs-id>] [--daemon-port <port>]
  node bridge/bridge.mjs mvs-messages [--session <mvs-id>] [--limit <n>] [--daemon-port <port>]
  node bridge/bridge.mjs mvs-send --content <text>|--task <file> --yes [--session <mvs-id>] [--daemon-port <port>]
  node bridge/bridge.mjs tail [--lines <n>]
  node bridge/bridge.mjs stop`);
}

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
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
        commandLine = $_.CommandLine
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
  const promptChars = prompts.reduce((sum, prompt) => sum + Buffer.byteLength(prompt.text, "utf8"), 0);
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
}

function requiredModel() {
  return config.requireModel || config.defaultModel || "minimax/MiniMax-M3";
}

async function selectServer(args) {
  const requestedPort = argValue(args, "--port");
  const servers = await liveServers();
  const selected = requestedPort
    ? servers.find((s) => String(s.port) === String(requestedPort))
    : servers.find((s) => s.parentName === "MiniMax Code.exe" && s.config?.model === config.requireModel) ||
      servers.find((s) => s.config?.model === config.requireModel) ||
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
  return sessionID;
}

function mvsBase(port) {
  return `http://127.0.0.1:${port}/mavis/api`;
}

async function fetchMavisJson(pathname, options = {}, timeoutSec = 60) {
  const port = options.port || config.mavisDaemonPort || 15321;
  return await fetchJsonWithTimeout(`${mvsBase(port)}${pathname}`, options.fetchOptions || {}, timeoutSec);
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
  const body = {
    model: modelSpec(options.model || config.defaultModel),
    noReply: Boolean(options.noReply),
    parts: [{ type: "text", text }],
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

function turnSummary(result) {
  const info = result?.info || {};
  const tokens = info?.tokens || {};
  const cache = tokens?.cache || {};
  return {
    providerID: info.providerID || null,
    modelID: info.modelID || null,
    inputTokens: Number(tokens.input || 0),
    outputTokens: Number(tokens.output || 0),
    cacheWrite: Number(cache.write || 0),
    cacheRead: Number(cache.read || 0),
    reply: assistantText(result).slice(0, 200),
  };
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
  };
}

async function runCanarySequence(server, args, titlePrefix) {
  const session = await createSession(server.port, `${titlePrefix}-${Date.now()}`);
  const sessionID = session.id;
  if (sessionID && config.denySessions?.includes(sessionID)) {
    throw new Error(`refusing denied session ${sessionID}`);
  }
  const prompts = canaryPrompts(args);

  const timeoutSec = Math.min(config.maxWallClockSec || 180, 75);
  const messages = [];
  const turns = [];
  for (const prompt of prompts) {
    const result = await sendPrompt(server.port, sessionID, prompt.text, { timeoutSec });
    messages.push(result);
    turns.push({ label: prompt.label, path: prompt.path || null, chars: prompt.chars || prompt.text.length, ...turnSummary(result) });
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

async function statusCommand() {
  const servers = await liveServers();
  appendJsonl(ledgerPath, { event: "status", servers });
  printJson({ servers });
}

function canaryEstimateCommand(args) {
  const estimate = canaryEstimate(args);
  appendJsonl(ledgerPath, estimate);
  printJson(estimate);
}

async function canaryCommand(args) {
  const server = await selectServer(args);
  const canary = await runCanarySequence(server, args, "bridge-canary");
  const result = {
    event: "canary",
    port: server.port,
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
    canary = await runCanarySequence(server, args, "bridge-optimize-check");
  }
  const usageSession = argValue(args, "--session", canary?.sessionID || null);
  const usage = readUsage(usageSession);
  const verdict = optimizationVerdict({ route, canary, usage });
  const result = {
    event: "optimize-check",
    id: cryptoRandomID(),
    port: server.port,
    estimate: args.includes("--skip-canary") ? null : canaryEstimate(args),
    route,
    canary,
    usage,
    verdict,
  };
  appendJsonl(ledgerPath, result);
  appendJsonl(outboxPath, result);
  printJson(result);
}

async function askCommand(args) {
  const mode = argValue(args, "--mode", "review-only");
  if (!["review-only", "patch-proposal"].includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  const taskPath = argValue(args, "--task");
  if (!taskPath) throw new Error("--task is required");
  const task = fs.readFileSync(path.resolve(taskPath), "utf8");
  const server = await selectServer(args);
  const envelope = {
    event: "ask",
    id: cryptoRandomID(),
    mode,
    port: server.port,
    taskPath: path.resolve(taskPath),
    chars: task.length,
  };
  appendJsonl(inboxPath, envelope);

  const prompt = mode === "review-only"
    ? `Review only. Do not edit files. Answer concisely.\n\n${task}`
    : `Propose a unified diff only. Do not apply it.\n\n${task}`;
  const session = await createSession(server.port, `bridge-ask-${Date.now()}`);
  const result = await sendPrompt(server.port, session.id, prompt, { timeoutSec: config.maxWallClockSec || 180 });
  const signals = extractSignalsFromMessages([result]);
  const answer = assistantText(result);
  const out = { ...envelope, sessionID: session.id, signals, answer: answer.slice(-12000) };
  appendJsonl(ledgerPath, out);
  appendJsonl(outboxPath, out);
  printJson(out);
}

async function mvsStatusCommand(args) {
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
  const statusID = argValue(args, "--opencode-session", sessionID);
  const status = await fetchMavisJson(`/session/${encodeURIComponent(statusID)}`, { port }, 15);
  const resolvedSession = status?.session?.sessionId || null;
  if (resolvedSession && resolvedSession !== sessionID && !args.includes("--allow-mismatch")) {
    throw new Error(`mvs-status mismatch: requested ${sessionID}, resolved ${resolvedSession}`);
  }
  const out = { event: "mvs-status", port, requestedSession: sessionID, statusID, status };
  appendJsonl(ledgerPath, out);
  printJson(out);
}

async function mvsPeersCommand(args) {
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
  const peers = await fetchMavisJson(`/communication/peers?sessionId=${encodeURIComponent(sessionID)}`, { port }, 15);
  const out = { event: "mvs-peers", port, sessionID, peers };
  appendJsonl(ledgerPath, out);
  printJson(out);
}

async function mvsMessagesCommand(args) {
  const port = mvsDaemonPort(args);
  const sessionID = mvsSession(args);
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

function tailCommand(args) {
  const lines = Number(argValue(args, "--lines", "20"));
  for (const filePath of [ledgerPath, outboxPath]) {
    console.log(`\n== ${path.basename(filePath)} ==`);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).slice(-lines);
    for (const line of content) console.log(line);
  }
}

async function stopCommand() {
  console.log("Bridge has no daemon process. Stop opencode serve from MiniMax Code or restart it explicitly if needed.");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!command || command === "help" || command === "--help") return usage();
    if (command === "status") return await statusCommand();
    if (command === "canary-estimate") return canaryEstimateCommand(args);
    if (command === "canary") return await canaryCommand(args);
    if (command === "optimize-check") return await optimizeCheckCommand(args);
    if (command === "ask") return await askCommand(args);
    if (command === "mvs-status") return await mvsStatusCommand(args);
    if (command === "mvs-peers") return await mvsPeersCommand(args);
    if (command === "mvs-messages") return await mvsMessagesCommand(args);
    if (command === "mvs-send") return await mvsSendCommand(args);
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
