import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendDuetJournalEntry, readDuetJournalFile } from "../lib/duet-journal.mjs";
import { withFileLock, withFileLockAsync } from "../lib/duet-lock.mjs";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-duet-helper-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("duet journal helper reads and appends markdown entries", (t) => {
  const dir = sandbox(t);
  const journalPath = path.join(dir, "duet-journal.md");
  fs.writeFileSync(journalPath, "# Duet Journal\n", "utf8");

  appendDuetJournalEntry(journalPath, "## Note\n\nhello");
  const journal = readDuetJournalFile(journalPath);
  assert.match(journal, /# Duet Journal/);
  assert.match(journal, /## Note/);
  assert.match(journal, /hello/);
});

test("duet journal helper reports missing and empty journals", (t) => {
  const dir = sandbox(t);
  const journalPath = path.join(dir, "duet-journal.md");
  assert.throws(() => readDuetJournalFile(journalPath), /duet journal is missing/);

  fs.writeFileSync(journalPath, "   \n", "utf8");
  assert.throws(() => readDuetJournalFile(journalPath), /duet journal is empty/);
});

test("duet lock helper serializes access and cleans up", (t) => {
  const dir = sandbox(t);
  const lockPath = path.join(dir, "duet.lock");
  const now = () => "2026-01-01T00:00:00.000Z";

  const result = withFileLock(() => {
    assert.equal(fs.existsSync(lockPath), true);
    assert.throws(
      () => withFileLock(() => null, { lockPath, staleMs: 60000, now }),
      /duet lock is held/,
    );
    return "ok";
  }, { lockPath, staleMs: 60000, now });

  assert.equal(result, "ok");
  assert.equal(fs.existsSync(lockPath), false);
});

test("duet lock helper refuses stale locks instead of removing them unsafely", (t) => {
  const dir = sandbox(t);
  const lockPath = path.join(dir, "duet.lock");
  fs.writeFileSync(lockPath, "stale", "utf8");
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockPath, old, old);

  assert.throws(
    () => withFileLock(() => null, { lockPath, staleMs: 1000, now: () => "2026-01-01T00:00:00.000Z" }),
    /refusing automatic removal/,
  );
  assert.equal(fs.readFileSync(lockPath, "utf8"), "stale");
});

test("async duet lock helper cleans up after awaited work", async (t) => {
  const dir = sandbox(t);
  const lockPath = path.join(dir, "duet.lock");

  const result = await withFileLockAsync(async () => {
    assert.equal(fs.existsSync(lockPath), true);
    return "async-ok";
  }, { lockPath, staleMs: 60000, now: () => "2026-01-01T00:00:00.000Z" });

  assert.equal(result, "async-ok");
  assert.equal(fs.existsSync(lockPath), false);
});
