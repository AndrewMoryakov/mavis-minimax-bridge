import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeVerifier, verifierArgs, verifierEnv } from "../lib/verifier.mjs";

const LIMITS = {
  maxBytes: 256 * 1024,
  maxArgs: 256,
  maxArgBytes: 32 * 1024,
  maxStreamBytes: 1024 * 1024,
};

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mavis-verifier-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function verifier(bridgeDir) {
  return makeVerifier({ bridgeDir, now: () => "2026-06-28T00:00:00.000Z", limits: LIMITS });
}

test("verifierArgs splits options from forwarded args on the -- separator", () => {
  assert.deepEqual(verifierArgs(["--verifier", "v.mjs", "--", "a", "b"]), {
    options: ["--verifier", "v.mjs"],
    forwarded: ["a", "b"],
  });
  assert.deepEqual(verifierArgs(["--verifier", "v.mjs"]), {
    options: ["--verifier", "v.mjs"],
    forwarded: [],
  });
});

test("validateForwardedVerifierArgs rejects too many args, NUL bytes, and oversized args", (t) => {
  const { validateForwardedVerifierArgs } = verifier(sandbox(t));
  assert.doesNotThrow(() => validateForwardedVerifierArgs(["--flag", "value"]));
  assert.throws(() => validateForwardedVerifierArgs(new Array(257).fill("x")), /too many verifier args/);
  assert.throws(() => validateForwardedVerifierArgs(["ok", "bad\0arg"]), /NUL bytes/);
  assert.throws(() => validateForwardedVerifierArgs(["x".repeat(32 * 1024 + 1)]), /verifier arg too large/);
});

test("resolveVerifierPath accepts a script inside the root and reports its metadata", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "verify.mjs");
  fs.writeFileSync(file, "process.exit(0)\n", "utf8");
  const { resolveVerifierPath } = verifier(dir);

  const resolved = resolveVerifierPath(file);
  assert.equal(resolved.basename, "verify.mjs");
  assert.equal(resolved.path, fs.realpathSync(file));
  assert.equal(resolved.bytes, fs.statSync(file).size);
});

test("resolveVerifierPath enforces NUL, extension, and bridge-root boundaries", (t) => {
  const dir = sandbox(t);
  const { resolveVerifierPath } = verifier(dir);

  assert.throws(() => resolveVerifierPath("verify\0.mjs"), /NUL bytes/);

  const wrongExt = path.join(dir, "verify.txt");
  fs.writeFileSync(wrongExt, "noop\n", "utf8");
  assert.throws(() => resolveVerifierPath(wrongExt), /\.js, \.mjs, or \.cjs/);

  const outside = sandbox(t);
  const escaped = path.join(outside, "verify.mjs");
  fs.writeFileSync(escaped, "process.exit(0)\n", "utf8");
  assert.throws(() => resolveVerifierPath(escaped), /escapes bridge root/);
});

test("verifierEnv blanks sensitive vars and drops non-allowlisted keys", () => {
  const key = "MAVIS_VERIFIER_TEST_SECRET";
  process.env[key] = "leak";
  try {
    const env = verifierEnv();
    assert.equal(env[key], undefined, "non-allowlisted keys must be dropped");
    assert.equal(env.HOME, "");
    assert.equal(env.USERPROFILE, "");
    assert.equal(env.NODE_OPTIONS, "");
  } finally {
    delete process.env[key];
  }
});

test("summarizeStream redacts by default and exposes raw text when asked", (t) => {
  const { summarizeStream } = verifier(sandbox(t));
  const buffer = Buffer.from("line one\nline two\n");

  const redacted = summarizeStream(buffer, false);
  assert.equal(redacted.mode, "redacted");
  assert.equal(redacted.lines, 3);
  assert.ok(redacted.head && redacted.tail);
  assert.equal(redacted.text, undefined);

  const raw = summarizeStream(buffer, true);
  assert.equal(raw.mode, "raw");
  assert.equal(raw.text, "line one\nline two\n");
});

test("runVerifierProcess runs a script and reports an ok result", async (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "verify.mjs");
  fs.writeFileSync(file, "process.stdout.write('VERIFIER_OK')\nprocess.exit(0)\n", "utf8");
  const v = verifier(dir);

  const resolved = v.resolveVerifierPath(file);
  const result = await v.runVerifierProcess(resolved, [], 30, true);
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.text, "VERIFIER_OK");
});
