import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchJsonWithTimeout } from "./http-json.mjs";

export function mvsBase(port) {
  return `http://127.0.0.1:${port}/mavis/api`;
}

export function usageSummary(usage) {
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

export function makeMvsClient({ config, runJson }) {
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

  function sessionDirectory(directoryOverride = null) {
    return directoryOverride || config.sessionDirectory || path.join(os.homedir(), ".minimax", "agents", "mavis", "workspace");
  }

  function sessionQuery(directoryOverride = null) {
    return `directory=${encodeURIComponent(sessionDirectory(directoryOverride))}`;
  }

  function messageUrl(port, sessionID, options = {}) {
    return `http://127.0.0.1:${port}/session/${sessionID}/message?${sessionQuery(options.directory)}`;
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

  async function createSession(port, title, options = {}) {
    return await fetchJsonWithTimeout(
      `http://127.0.0.1:${port}/session?${sessionQuery(options.directory)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      },
      10,
    );
  }

  function mavisCli() {
    if (config.mavisCli) return config.mavisCli;
    const cmd = path.join(os.homedir(), ".mavis", "bin", process.platform === "win32" ? "mavis.cmd" : "mavis");
    return fs.existsSync(cmd) ? cmd : "mavis";
  }

  function readUsage(sessionID) {
    if (!sessionID) return { skipped: true, reason: "no session id" };
    if (!String(sessionID).startsWith("mvs_")) {
      return { skipped: true, sessionID, reason: "not a Mavis session id; pass --session mvs_<id> to collect mavis usage" };
    }
    try {
      assertMvsSessionID(sessionID, "usage");
    } catch (error) {
      return { skipped: true, sessionID, reason: error.message };
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

  return {
    isDeniedSession,
    assertNotDeniedSession,
    assertMvsSessionID,
    sessionDirectory,
    sessionQuery,
    messageUrl,
    fetchMavisJson,
    verifyMavisSession,
    createSession,
    mavisCli,
    readUsage,
  };
}
