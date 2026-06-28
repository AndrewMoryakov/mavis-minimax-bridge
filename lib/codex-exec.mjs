import { spawnSync } from "node:child_process";

export function parseCodexJsonEvents(text) {
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

export function lastCodexUsage(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = events[index]?.usage;
    if (usage && typeof usage === "object") return usage;
  }
  return null;
}

export function requireCodexMode(value, fallback = "exec") {
  const mode = String(value || fallback).toLowerCase();
  if (!["exec", "isolated"].includes(mode)) throw new Error("--codex-mode must be isolated or exec");
  return mode;
}

export function codexPromptPathForOutput(outputPath) {
  return outputPath.replace(/\.pending\.local\.md$/i, ".prompt.local.txt");
}

export function codexIsolationWarning(codexMode) {
  return codexMode === "isolated" ? "codex_isolated_is_scratch_readonly_not_hard_security_boundary" : null;
}

export function terminateChildProcessTree(child) {
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
