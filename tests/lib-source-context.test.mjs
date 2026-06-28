import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makePaths } from "../lib/paths.mjs";
import { makeSourceContext, readSourceSnippet } from "../lib/source-context.mjs";

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mavis-srcctx-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function context(bridgeDir) {
  return makeSourceContext({
    bridgeDir,
    paths: makePaths(bridgeDir),
    limits: { maxFiles: 80, maxDirs: 160 },
  });
}

test("shouldSkipSourceContextPath skips runtime, vcs, and local files", (t) => {
  const dir = sandbox(t);
  const { shouldSkipSourceContextPath } = context(dir);

  assert.equal(shouldSkipSourceContextPath("config.json"), true);
  assert.equal(shouldSkipSourceContextPath("ledger.jsonl"), true);
  assert.equal(shouldSkipSourceContextPath(".git/config"), true);
  assert.equal(shouldSkipSourceContextPath("node_modules/pkg/index.js"), true);
  assert.equal(shouldSkipSourceContextPath("live-smoke-foo/x.txt"), true);
  assert.equal(shouldSkipSourceContextPath(".env"), true);
  assert.equal(shouldSkipSourceContextPath("sub/.env"), true);
  assert.equal(shouldSkipSourceContextPath(".env.local"), true);
  assert.equal(shouldSkipSourceContextPath("sub/.env.production"), true);
  assert.equal(shouldSkipSourceContextPath(".envrc"), true);
  assert.equal(shouldSkipSourceContextPath(".npmrc"), true);
  assert.equal(shouldSkipSourceContextPath("secrets.json"), true);
  assert.equal(shouldSkipSourceContextPath("keys/id_ed25519"), true);
  assert.equal(shouldSkipSourceContextPath("certs/client.pem"), true);
  assert.equal(shouldSkipSourceContextPath("notes.local.md"), true);

  assert.equal(shouldSkipSourceContextPath("src/app.js"), false);
  assert.equal(shouldSkipSourceContextPath("README.md"), false);
});

test("shouldSkipSourceContextPath matches runtime files by basename even when nested", (t) => {
  const dir = sandbox(t);
  const { shouldSkipSourceContextPath } = context(dir);
  // Regression guard: deny-list is basename-based, not absolute-path equality.
  assert.equal(shouldSkipSourceContextPath("sub/config.json"), true);
  assert.equal(shouldSkipSourceContextPath("nested/dir/duet-state.json"), true);
});

test("readSourceSnippet truncates files beyond the per-file limit", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "big.txt");
  fs.writeFileSync(file, "x".repeat(500), "utf8");

  const result = readSourceSnippet(file, "big.txt", 100);
  assert.equal(result.included, true);
  assert.equal(result.skipped, false);
  assert.match(result.text, /\[truncated: file is 500 bytes\]/);
  assert.ok(!result.text.includes("x".repeat(101)), "body must be sliced to the per-file limit");
});

test("readSourceSnippet rejects binary-looking files", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "bin.dat");
  fs.writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]));

  const result = readSourceSnippet(file, "bin.dat", 100);
  assert.equal(result.included, false);
  assert.equal(result.skipped, true);
  assert.match(result.text, /binary-looking file/);
});

test("readSourceSnippet reports missing files", (t) => {
  const dir = sandbox(t);
  const result = readSourceSnippet(path.join(dir, "nope.txt"), "nope.txt", 100);
  assert.equal(result.included, false);
  assert.equal(result.skipped, true);
  assert.match(result.text, /\[skipped: not found\]/);
});

test("includedSourceFiles collects files inside the root and skips denied ones", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)\n", "utf8");
  fs.writeFileSync(path.join(dir, "config.json"), "{}", "utf8");
  const { includedSourceFiles } = context(dir);

  const result = includedSourceFiles([path.join(dir, "app.js"), path.join(dir, "config.json")]);
  assert.deepEqual(result.files.map((f) => f.relativePath), ["app.js"]);
  assert.ok(result.skipped.some((s) => s.path === "config.json" && s.reason === "excluded"));
});

test("includedSourceFiles rejects paths that escape the bridge root", (t) => {
  const dir = sandbox(t);
  const outside = sandbox(t);
  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, "nope", "utf8");
  const { includedSourceFiles } = context(dir);

  assert.throws(() => includedSourceFiles([outsideFile]), /escapes bridge root/);
});
