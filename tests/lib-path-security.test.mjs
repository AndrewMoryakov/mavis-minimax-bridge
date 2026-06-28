import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInsideRoot, pathsEqual, realpathOrResolve } from "../lib/path-security.mjs";

test("path security resolves existing and missing paths consistently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-path-security-"));
  const child = path.join(root, "child.txt");
  fs.writeFileSync(child, "x", "utf8");

  assert.equal(realpathOrResolve(child), fs.realpathSync.native(child));
  assert.equal(path.resolve(root, "missing.txt"), realpathOrResolve(path.join(root, "missing.txt")));
});

test("path security detects equality and root containment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-path-security-"));
  const childDir = path.join(root, "child");
  fs.mkdirSync(childDir);
  const sibling = `${root}-sibling`;
  fs.mkdirSync(sibling);

  assert.equal(pathsEqual(root, path.join(root, ".")), true);
  assert.equal(isPathInsideRoot(root, root), true);
  assert.equal(isPathInsideRoot(root, childDir), true);
  assert.equal(isPathInsideRoot(root, sibling), false);
});
