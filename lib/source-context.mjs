import fs from "node:fs";
import path from "node:path";

import { comparablePath, isPathInsideRoot, realpathOrResolve } from "./path-security.mjs";
import { isProbablyText } from "./text-utils.mjs";

export function readSourceSnippet(fullPath, displayPath, perFileLimit) {
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

export function makeSourceContext({ bridgeDir, paths, limits }) {
  const maxFiles = limits.maxFiles;
  const maxDirs = limits.maxDirs;
  // Runtime-file deny entries are derived from the bridge paths so they cannot
  // drift from lib/paths.mjs; they are matched by basename (see below).
  const runtimeDenyBasenames = new Set([
    paths.configPath,
    paths.ledgerPath,
    paths.inboxPath,
    paths.outboxPath,
    paths.duetStatePath,
    paths.duetJournalPath,
    paths.duetLockPath,
  ].map((entry) => path.basename(entry)));

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
    if (base === ".env" || base.startsWith(".env.") || base === ".envrc") return true;
    if ([".npmrc", ".pypirc", ".netrc", "secrets.json", "secret.json"].includes(base)) return true;
    if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\..*)?$/i.test(base)) return true;
    if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
    if (lower.endsWith(".local.md") || lower.includes(".local.")) return true;
    if (runtimeDenyBasenames.has(base)) return true;
    if (/^duet-(state|journal)\.json\..*\.tmp$/i.test(base)) return true;
    if (lower === "examples/duet-simple-orders/answer.json") return true;
    if ([
      "examples/duet-tetris-browser/index.html",
      "examples/duet-tetris-browser/styles.css",
      "examples/duet-tetris-browser/game.js",
    ].includes(lower)) return true;
    return false;
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
      if (files.length >= maxFiles) {
        fileLimitReached = true;
        skipped.push({ path: relative, reason: `file limit reached (${maxFiles})` });
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
      if (visitedDirectories.size >= maxDirs) {
        dirLimitReached = true;
        skipped.push({ path: relativeBridgePath(realPath), reason: `directory limit reached (${maxDirs})` });
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
        maxFiles,
        maxDirs,
        fileLimitReached,
        dirLimitReached,
      },
    };
  }

  return { shouldSkipSourceContextPath, includedSourceFiles };
}
