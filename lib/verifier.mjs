import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { isPathInsideRoot, realpathOrResolve } from "./path-security.mjs";
import { textDigest, textSummary } from "./text-utils.mjs";

export function verifierArgs(args) {
  const separator = args.indexOf("--");
  return {
    options: separator >= 0 ? args.slice(0, separator) : args,
    forwarded: separator >= 0 ? args.slice(separator + 1) : [],
  };
}

export function verifierEnv() {
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

export function killProcessTree(pid) {
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

export function makeVerifier({ bridgeDir, now, limits }) {
  const { maxBytes, maxArgs, maxArgBytes, maxStreamBytes } = limits;

  function validateForwardedVerifierArgs(args) {
    if (args.length > maxArgs) {
      throw new Error(`too many verifier args: ${args.length} > ${maxArgs}`);
    }
    for (const value of args) {
      if (String(value).includes("\0")) throw new Error("verifier args must not contain NUL bytes");
      const bytes = Buffer.byteLength(String(value), "utf8");
      if (bytes > maxArgBytes) {
        throw new Error(`verifier arg too large: ${bytes} bytes > ${maxArgBytes}`);
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
    if (stats.size > maxBytes) {
      throw new Error(`verifier file too large: ${stats.size} bytes > ${maxBytes}`);
    }
    return { path: realPath, basename: path.basename(realPath), bytes: stats.size };
  }

  function summarizeStream(buffer, raw, totalBytes = buffer.length) {
    const text = buffer.toString("utf8");
    const truncated = totalBytes > maxStreamBytes || buffer.length > maxStreamBytes;
    const capped = truncated ? text.slice(0, maxStreamBytes) : text;
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
        if (storedBytes >= maxStreamBytes + 1) return;
        const remaining = maxStreamBytes + 1 - storedBytes;
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
          truncated: stdoutBytes > maxStreamBytes || stderrBytes > maxStreamBytes,
        });
      });
    });
  }

  return { validateForwardedVerifierArgs, resolveVerifierPath, summarizeStream, runVerifierProcess };
}
