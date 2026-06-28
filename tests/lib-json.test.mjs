import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  escapeNonAscii,
  readJson,
  readJsonFromString,
  readJsonl,
  stableStringify,
} from "../lib/json.mjs";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-json-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("json helpers read fallback values and parse valid json", (t) => {
  const dir = sandbox(t);
  const filePath = path.join(dir, "data.json");
  fs.writeFileSync(filePath, "{\"ok\":true}", "utf8");

  assert.deepEqual(readJson(filePath, { ok: false }), { ok: true });
  assert.deepEqual(readJson(path.join(dir, "missing.json"), { missing: true }), { missing: true });
  fs.writeFileSync(filePath, "{broken", "utf8");
  assert.deepEqual(readJson(filePath, { fallback: true }), { fallback: true });
});

test("json string helpers preserve fallback and stable formatting", () => {
  assert.deepEqual(readJsonFromString("{\"a\":1}", null), { a: 1 });
  assert.equal(readJsonFromString("{broken", "fallback"), "fallback");
  assert.equal(stableStringify({ b: 2 }), "{\n  \"b\": 2\n}\n");
});

test("jsonl helper reads trailing valid lines and ignores invalid lines", (t) => {
  const dir = sandbox(t);
  const filePath = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(filePath, [
    "{\"a\":1}",
    "{broken",
    "{\"b\":2}",
    "{\"c\":3}",
  ].join("\n"), "utf8");
  const warnings = [];
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning, options) => {
    warnings.push({ warning, code: options?.code || null });
  };
  t.after(() => {
    process.emitWarning = originalEmitWarning;
  });

  assert.deepEqual(readJsonl(path.join(dir, "missing.jsonl")), []);
  assert.deepEqual(readJsonl(filePath, 2), [{ b: 2 }, { c: 3 }]);
  assert.deepEqual(readJsonl(filePath, 10), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(warnings.some((warning) => warning.code === "MAVIS_BRIDGE_JSONL_PARSE"), true);
});

test("escapeNonAscii escapes only non-ascii characters", () => {
  assert.equal(escapeNonAscii("abc"), "abc");
  assert.equal(escapeNonAscii("Привет"), "\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442");
});
