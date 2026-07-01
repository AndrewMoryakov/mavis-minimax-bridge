import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateTarget } from "../lib/orch-target.mjs";

function sandbox(t, prefix = "mavis-orch-target-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("validateTarget accepts a directory outside the bridge repository", (t) => {
  const bridge = sandbox(t, "mavis-bridge-root-");
  const target = sandbox(t, "mavis-target-root-");
  assert.equal(validateTarget(target, bridge), fs.realpathSync.native(target));
});

test("validateTarget rejects bridge, children of bridge, and parents of bridge", (t) => {
  const parent = sandbox(t, "mavis-parent-root-");
  const bridge = path.join(parent, "bridge");
  const child = path.join(bridge, "child");
  fs.mkdirSync(child, { recursive: true });

  assert.throws(() => validateTarget(bridge, bridge), /must not be the bridge repository/);
  assert.throws(() => validateTarget(child, bridge), /must not be inside the bridge repository/);
  assert.throws(() => validateTarget(parent, bridge), /must not contain the bridge repository/);
});

test("validateTarget rejects missing and non-directory targets", (t) => {
  const bridge = sandbox(t);
  const fileTarget = path.join(sandbox(t), "file.txt");
  fs.writeFileSync(fileTarget, "x", "utf8");

  assert.throws(() => validateTarget(path.join(bridge, "missing"), bridge), /target does not exist/);
  assert.throws(() => validateTarget(fileTarget, bridge), /target must be a directory/);
});
