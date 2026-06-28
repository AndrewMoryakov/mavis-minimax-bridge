import fs from "node:fs";
import path from "node:path";

export function realpathOrResolve(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

export function comparablePath(inputPath) {
  const normalized = path.normalize(realpathOrResolve(inputPath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

export function isPathInsideRoot(rootPath, candidatePath) {
  const root = comparablePath(rootPath);
  const candidate = comparablePath(candidatePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(rootWithSep);
}
