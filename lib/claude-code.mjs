import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const spawnableKinds = new Set(["executable", "cmd-shim", "bat-shim"]);
const nonSpawnablePowerShellTypes = new Set(["Alias", "Function", "Filter", "Cmdlet", "ExternalScript", "Script"]);
const ansiPattern = /\u001b\[[0-9;]*m/g;
const secretKeyPattern = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;

export function defaultClaudeCli(platform = process.platform) {
  return platform === "win32" ? "claude.cmd" : "claude";
}

export function classifyClaudePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".cmd") return "cmd-shim";
  if (ext === ".bat") return "bat-shim";
  return "executable";
}

function shellCommand(platform, command) {
  return platform === "win32"
    ? { file: "where", args: [command] }
    : { file: "which", args: [command] };
}

function runCommandDefault(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
        child.kill();
        finish({ ok: false, stdout, stderr, exitCode: null, timedOut: true, error: "timeout" });
      }, options.timeoutMs)
      : null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ ok: false, stdout, stderr, exitCode: null, timedOut: false, error: error.message });
    });
    child.on("exit", (code) => {
      finish({ ok: code === 0, stdout, stderr, exitCode: code, timedOut: false, error: null });
    });
  });
}

function statFile(filePath, fsModule) {
  try {
    const lstat = fsModule.lstatSync(filePath);
    const stat = fsModule.statSync(filePath);
    if (!stat.isFile()) return { ok: false, mode: null, isSymlink: lstat.isSymbolicLink(), error: "not-file" };
    return { ok: true, mode: stat.mode, isSymlink: lstat.isSymbolicLink(), error: null };
  } catch (error) {
    return { ok: false, mode: null, isSymlink: false, error: error.message };
  }
}

function lines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function baseCliResult(result) {
  return {
    ...result,
    found: Boolean(result.path || result.command),
    spawnable: Boolean(result.available),
  };
}

function resultFromPath({ configuredCli, filePath, source, fsModule }) {
  const stat = statFile(filePath, fsModule);
  if (!stat.ok) {
    return missingResult(configuredCli, source, `Claude CLI not found at ${filePath}`, stat);
  }
  const kind = classifyClaudePath(filePath);
  return baseCliResult({
    configuredCli,
    available: spawnableKinds.has(kind),
    kind,
    command: filePath,
    path: filePath,
    source,
    probe: { which: null, stat, powershell: null },
    warning: null,
    remediation: null,
  });
}

function missingResult(configuredCli, source, warning, stat = null, which = null, powershell = null) {
  return baseCliResult({
    configuredCli,
    available: false,
    kind: "missing",
    command: null,
    path: null,
    source,
    probe: { which, stat, powershell },
    warning,
    remediation: "Install Claude Code CLI or set claudeCli to a spawnable executable, .cmd, or .bat path.",
  });
}

function errorResult(configuredCli, source, warning, which = null, powershell = null) {
  return baseCliResult({
    configuredCli,
    available: false,
    kind: "error",
    command: null,
    path: null,
    source,
    probe: { which, stat: null, powershell },
    warning,
    remediation: "Check Claude CLI installation and shell configuration.",
  });
}

async function resolveFromPathLookup({ configuredCli, command, platform, runCommand, fsModule, timeoutMs }) {
  const lookup = shellCommand(platform, command);
  const which = await runCommand(lookup.file, lookup.args, { timeoutMs });
  if (!which.ok) return { result: null, which };

  const candidates = lines(which.stdout);
  const sorted = platform === "win32"
    ? [...candidates].sort((a, b) => Number(path.extname(a).toLowerCase() !== ".exe") - Number(path.extname(b).toLowerCase() !== ".exe"))
    : candidates;
  for (const candidate of sorted) {
    const resolved = path.resolve(candidate);
    const stat = statFile(resolved, fsModule);
    if (stat.ok) {
      const kind = classifyClaudePath(resolved);
      return {
        result: baseCliResult({
          configuredCli,
          available: spawnableKinds.has(kind),
          kind,
          command: resolved,
          path: resolved,
          source: "path",
          probe: { which, stat, powershell: null },
          warning: null,
          remediation: null,
        }),
        which,
      };
    }
  }
  return { result: null, which };
}

async function powershellProbe({ configuredCli, runCommand, fsModule, timeoutMs }) {
  const script = [
    "$c = Get-Command claude -ErrorAction SilentlyContinue;",
    "if ($null -eq $c) { exit 3 }",
    "[Console]::Out.WriteLine($c.CommandType);",
    "[Console]::Out.WriteLine($c.Source);",
    "[Console]::Out.WriteLine($c.Definition);",
  ].join(" ");
  const probe = await runCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs });
  const probeInfo = {
    detected: probe.ok,
    name: null,
    exitCode: probe.exitCode ?? null,
    stdout: probe.stdout || "",
    stderr: probe.stderr || "",
    error: probe.error || null,
    timedOut: Boolean(probe.timedOut),
  };
  if (!probe.ok) {
    if (probe.timedOut || probe.error) {
      return errorResult(configuredCli, "powershell", "PowerShell Claude probe failed.", null, probeInfo);
    }
    return missingResult(configuredCli, "powershell", "Claude CLI was not found.", null, null, probeInfo);
  }

  const [commandType, source, definition] = lines(probe.stdout);
  probeInfo.name = commandType || null;
  if (commandType === "Application") {
    const candidate = source || definition;
    if (candidate) {
      const resolved = path.resolve(candidate);
      const result = resultFromPath({ configuredCli, filePath: resolved, source: "powershell", fsModule });
      result.probe.powershell = probeInfo;
      return result;
    }
  }
  if (nonSpawnablePowerShellTypes.has(commandType)) {
    return baseCliResult({
      configuredCli,
      available: false,
      kind: "powershell-function",
      command: null,
      path: definition || source || "claude",
      source: "powershell",
      probe: { which: null, stat: null, powershell: probeInfo },
      warning: `Claude is a PowerShell ${commandType}, not a directly spawnable executable.`,
      remediation: "Install a standalone Claude CLI or set claudeCli to a spawnable executable, .cmd, or .bat path.",
    });
  }
  return errorResult(configuredCli, "powershell", `Unsupported PowerShell Claude command type: ${commandType || "unknown"}`, null, probeInfo);
}

export async function resolveClaudeCli(options = {}) {
  const configuredCli = typeof options.configuredCli === "string" && options.configuredCli.trim()
    ? options.configuredCli.trim()
    : null;
  const platform = options.platform || process.platform;
  const fsModule = options.fs || fs;
  const runCommand = options.runCommand || runCommandDefault;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 1500;

  if (configuredCli) {
    const resolved = path.isAbsolute(configuredCli) || configuredCli.includes(path.sep)
      ? path.resolve(configuredCli)
      : configuredCli;
    if (path.isAbsolute(resolved)) {
      return resultFromPath({ configuredCli, filePath: resolved, source: "config", fsModule });
    }
    const lookup = await resolveFromPathLookup({ configuredCli, command: resolved, platform, runCommand, fsModule, timeoutMs });
    return lookup.result || missingResult(configuredCli, "config", `Claude CLI command not found: ${configuredCli}`, null, lookup.which);
  }

  const defaults = platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : [defaultClaudeCli(platform)];
  let lastWhich = null;
  for (const command of defaults) {
    const lookup = await resolveFromPathLookup({ configuredCli, command, platform, runCommand, fsModule, timeoutMs });
    lastWhich = lookup.which;
    if (lookup.result) return lookup.result;
  }

  if (platform === "win32") return powershellProbe({ configuredCli, runCommand, fsModule, timeoutMs });
  return missingResult(configuredCli, "default", "Claude CLI was not found on PATH.", null, lastWhich);
}

export function buildClaudeArgs(config = {}) {
  const maxTurns = Number.isFinite(Number(config.claudeMaxTurns)) ? Number(config.claudeMaxTurns) : 1;
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(maxTurns),
  ];
  if (typeof config.claudeModel === "string" && config.claudeModel.trim()) {
    args.push("--model", config.claudeModel.trim());
  }
  if (config.claudeMaxBudgetUsd !== null && config.claudeMaxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(config.claudeMaxBudgetUsd));
  }
  return args;
}

function promptEnvelope(prompt) {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: String(prompt || "") }],
    },
  })}\n`;
}

function numericOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function usageFrom(value) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    inputTokens: numericOrNull(usage.input_tokens ?? usage.inputTokens),
    outputTokens: numericOrNull(usage.output_tokens ?? usage.outputTokens),
    cacheReadTokens: numericOrNull(usage.cache_read_tokens ?? usage.cacheReadTokens),
    cacheCreationTokens: numericOrNull(usage.cache_creation_tokens ?? usage.cacheCreationTokens),
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function safeControlRequest(event) {
  return {
    type: event?.type || null,
    requestId: event?.request_id || event?.requestId || null,
    toolName: event?.tool?.name || event?.tool_name || event?.toolName || null,
  };
}

function emptyClaudeResult() {
  return {
    ok: false,
    provider: "anthropic",
    agent: "claude",
    model: null,
    sessionId: null,
    answer: "",
    usage: usageFrom(null),
    costUsd: null,
    exitCode: null,
    timedOut: false,
    durationMs: null,
    resultSubtype: null,
    isError: false,
    stopReason: null,
    numTurns: null,
    permissionDenials: 0,
    rateLimitEvents: [],
    diagnostics: {
      malformedLines: [],
      stderrSummary: "",
      stdoutSummary: "",
      controlRequest: null,
      warnings: [],
    },
  };
}

export function parseClaudeStreamJson(text) {
  const parsed = emptyClaudeResult();
  const answerParts = [];
  let sawResult = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      parsed.diagnostics.malformedLines.push(rawLine);
      continue;
    }

    if (event.type === "system") {
      parsed.model = event.model || parsed.model;
      parsed.sessionId = event.session_id || event.sessionId || parsed.sessionId;
    }
    if (event.type === "assistant") {
      answerParts.push(textFromContent(event.message?.content));
    }
    if (event.type === "rate_limit_event") {
      parsed.rateLimitEvents.push(event);
    }
    if (event.type === "control_request" || event.type === "user_question" || event.type === "ask_user_question" || event.type === "AskUserQuestion") {
      parsed.ok = false;
      parsed.isError = true;
      parsed.resultSubtype = event.type === "control_request" ? "control_request" : "user_question";
      parsed.permissionDenials += 1;
      parsed.diagnostics.controlRequest = safeControlRequest(event);
    }
    if (event.type === "result") {
      sawResult = true;
      parsed.model = event.model || parsed.model;
      parsed.sessionId = event.session_id || event.sessionId || parsed.sessionId;
      parsed.usage = usageFrom(event.usage);
      parsed.costUsd = numericOrNull(event.total_cost_usd ?? event.cost_usd ?? event.costUsd);
      parsed.durationMs = numericOrNull(event.duration_ms ?? event.durationMs);
      parsed.numTurns = numericOrNull(event.num_turns ?? event.numTurns);
      parsed.stopReason = event.stop_reason || event.stopReason || null;
      if (!parsed.resultSubtype) parsed.resultSubtype = event.subtype || null;
      parsed.isError = Boolean(parsed.isError || event.is_error || event.isError);
    }
  }
  parsed.answer = answerParts.join("");
  parsed.ok = Boolean(sawResult && !parsed.isError && parsed.diagnostics.malformedLines.length === 0);
  if (parsed.diagnostics.malformedLines.length > 0) {
    parsed.diagnostics.warnings.push("malformed_json_lines");
  }
  return parsed;
}

export function redactClaudeText(text, maxChars = 4000) {
  let output = String(text || "").replace(ansiPattern, "").replace(/\s+/g, " ").trim();
  output = output.replace(/(Authorization|Proxy-Authorization)\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "$1: Bearer [REDACTED]");
  output = output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  output = output.replace(/([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Za-z0-9_]*)\s*=\s*[^\s,;]+/gi, "$1=[REDACTED]");
  if (output.length > maxChars) return `${output.slice(0, maxChars)}...[truncated]`;
  return output;
}

export function redactClaudeEnv(env = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(env || {})) {
    redacted[key] = secretKeyPattern.test(key) ? "[REDACTED]" : value;
  }
  return redacted;
}

function defaultKillProcessTree(child, options = {}) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T"], { windowsHide: true, stdio: "ignore" });
    setTimeout(() => {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }, options.forceAfterMs ?? 2000).unref?.();
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      // Process already exited.
    }
  }, options.forceAfterMs ?? 2000).unref?.();
}

function spawnClaudeProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = options.spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = options.now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout, stderr, durationMs: options.now() - startedAt });
    };
    const timer = setTimeout(() => {
      options.killImpl(child, { signal: "SIGTERM", forceAfterMs: 2000 });
      finish({ exitCode: null, signal: "timeout", timedOut: true, error: "timeout" });
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, timedOut: false, error: error.message });
    });
    child.on("exit", (code, signal) => {
      finish({ exitCode: code, signal, timedOut: false, error: null });
    });
    child.stdin?.end(promptEnvelope(options.prompt));
  });
}

export async function runClaudePrompt(options = {}) {
  const config = options.config || {};
  const cli = options.cli || await resolveClaudeCli({
    configuredCli: config.claudeCli,
    timeoutMs: config.claudeCliSearchTimeoutMs,
  });
  if (!cli?.available) {
    return {
      ...emptyClaudeResult(),
      ok: false,
      isError: true,
      resultSubtype: "missing_cli",
      diagnostics: {
        ...emptyClaudeResult().diagnostics,
        cli,
        warnings: [cli?.warning || "Claude CLI is not available"],
      },
    };
  }

  const command = cli.command;
  const args = buildClaudeArgs(config);
  const run = await spawnClaudeProcess(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    prompt: options.prompt,
    spawnImpl: options.spawnImpl || spawn,
    killImpl: options.killImpl || defaultKillProcessTree,
    now: options.now || Date.now,
    timeoutMs: Number.isFinite(Number(config.claudeRunnerTimeoutMs)) ? Number(config.claudeRunnerTimeoutMs) : 60000,
  });

  const parsed = parseClaudeStreamJson(run.stdout);
  parsed.exitCode = run.exitCode;
  parsed.timedOut = Boolean(run.timedOut);
  parsed.durationMs = parsed.durationMs ?? run.durationMs;
  parsed.diagnostics.stderrSummary = redactClaudeText(run.stderr);
  parsed.diagnostics.stdoutSummary = redactClaudeText(run.stdout);
  parsed.diagnostics.argv = args;
  if (run.timedOut) {
    parsed.ok = false;
    parsed.isError = true;
    parsed.resultSubtype = "timeout";
    parsed.diagnostics.warnings.push("claude_runner_timeout");
  } else if (run.exitCode !== 0 && !parsed.isError) {
    parsed.ok = false;
    parsed.isError = true;
    parsed.resultSubtype = "non_zero_exit";
  }
  return parsed;
}
