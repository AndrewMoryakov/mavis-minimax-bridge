import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const spawnableKinds = new Set(["executable", "cmd-shim", "bat-shim"]);
const nonSpawnablePowerShellTypes = new Set(["Alias", "Function", "Filter", "Cmdlet", "ExternalScript", "Script"]);

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

function resultFromPath({ configuredCli, filePath, source, fsModule }) {
  const stat = statFile(filePath, fsModule);
  if (!stat.ok) {
    return missingResult(configuredCli, source, `Claude CLI not found at ${filePath}`, stat);
  }
  const kind = classifyClaudePath(filePath);
  return {
    configuredCli,
    available: spawnableKinds.has(kind),
    kind,
    command: filePath,
    path: filePath,
    source,
    probe: { which: null, stat, powershell: null },
    warning: null,
    remediation: null,
  };
}

function missingResult(configuredCli, source, warning, stat = null, which = null, powershell = null) {
  return {
    configuredCli,
    available: false,
    kind: "missing",
    command: null,
    path: null,
    source,
    probe: { which, stat, powershell },
    warning,
    remediation: "Install Claude Code CLI or set claudeCli to a spawnable executable, .cmd, or .bat path.",
  };
}

function errorResult(configuredCli, source, warning, which = null, powershell = null) {
  return {
    configuredCli,
    available: false,
    kind: "error",
    command: null,
    path: null,
    source,
    probe: { which, stat: null, powershell },
    warning,
    remediation: "Check Claude CLI installation and shell configuration.",
  };
}

async function resolveFromPathLookup({ configuredCli, command, platform, runCommand, fsModule }) {
  const lookup = shellCommand(platform, command);
  const which = await runCommand(lookup.file, lookup.args, { timeoutMs: 1500 });
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
        result: {
          configuredCli,
          available: spawnableKinds.has(kind),
          kind,
          command: resolved,
          path: resolved,
          source: "path",
          probe: { which, stat, powershell: null },
          warning: null,
          remediation: null,
        },
        which,
      };
    }
  }
  return { result: null, which };
}

async function powershellProbe({ configuredCli, runCommand, fsModule }) {
  const script = [
    "$c = Get-Command claude -ErrorAction SilentlyContinue;",
    "if ($null -eq $c) { exit 3 }",
    "[Console]::Out.WriteLine($c.CommandType);",
    "[Console]::Out.WriteLine($c.Source);",
    "[Console]::Out.WriteLine($c.Definition);",
  ].join(" ");
  const probe = await runCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 1500 });
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
    return {
      configuredCli,
      available: false,
      kind: "powershell-function",
      command: null,
      path: definition || source || "claude",
      source: "powershell",
      probe: { which: null, stat: null, powershell: probeInfo },
      warning: `Claude is a PowerShell ${commandType}, not a directly spawnable executable.`,
      remediation: "Install a standalone Claude CLI or set claudeCli to a spawnable executable, .cmd, or .bat path.",
    };
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

  if (configuredCli) {
    const resolved = path.isAbsolute(configuredCli) || configuredCli.includes(path.sep)
      ? path.resolve(configuredCli)
      : configuredCli;
    if (path.isAbsolute(resolved)) {
      return resultFromPath({ configuredCli, filePath: resolved, source: "config", fsModule });
    }
    const lookup = await resolveFromPathLookup({ configuredCli, command: resolved, platform, runCommand, fsModule });
    return lookup.result || missingResult(configuredCli, "config", `Claude CLI command not found: ${configuredCli}`, null, lookup.which);
  }

  const defaults = platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : [defaultClaudeCli(platform)];
  let lastWhich = null;
  for (const command of defaults) {
    const lookup = await resolveFromPathLookup({ configuredCli, command, platform, runCommand, fsModule });
    lastWhich = lookup.which;
    if (lookup.result) return lookup.result;
  }

  if (platform === "win32") return powershellProbe({ configuredCli, runCommand, fsModule });
  return missingResult(configuredCli, "default", "Claude CLI was not found on PATH.", null, lastWhich);
}
