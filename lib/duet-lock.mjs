import fs from "node:fs";

import { stableStringify } from "./json.mjs";

export const duetLockStaleMs = 10 * 60 * 1000;

function removeStaleLock(lockPath, staleMs) {
  let stats = null;
  try {
    stats = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (Date.now() - stats.mtimeMs <= staleMs) return;
  throw new Error("duet lock looks stale; refusing automatic removal to avoid concurrent writers. Retry after the other command exits or remove the lock manually after verifying no bridge command is running");
}

function acquireLock(lockPath, staleMs, payload) {
  removeStaleLock(lockPath, staleMs);
  const handle = fs.openSync(lockPath, "wx");
  fs.writeFileSync(handle, stableStringify(payload), "utf8");
  return handle;
}

function releaseLock(lockPath, handle) {
  if (handle !== null) fs.closeSync(handle);
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function withFileLock(callback, { lockPath, staleMs = duetLockStaleMs, now }) {
  let handle = null;
  try {
    handle = acquireLock(lockPath, staleMs, { pid: process.pid, createdAt: now() });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("duet lock is held by another command; retry after it finishes");
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    releaseLock(lockPath, handle);
  }
}

export async function withFileLockAsync(callback, { lockPath, staleMs = duetLockStaleMs, now }) {
  let handle = null;
  let heartbeat = null;
  try {
    handle = acquireLock(lockPath, staleMs, { pid: process.pid, createdAt: now(), async: true });
    heartbeat = setInterval(() => {
      try {
        const time = new Date();
        fs.utimesSync(lockPath, time, time);
      } catch (error) {
        process.emitWarning(`duet lock heartbeat failed: ${error.message}`, { code: "MAVIS_BRIDGE_LOCK_HEARTBEAT" });
      }
    }, Math.min(30000, Math.max(1000, Math.floor(staleMs / 4))));
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
    releaseLock(lockPath, handle);
  }
}
