import assert from "node:assert/strict";
import test from "node:test";

import { isProbablyText, textDigest, textSummary } from "../lib/text-utils.mjs";

test("isProbablyText treats NUL-free buffers as text and NUL buffers as binary", () => {
  assert.equal(isProbablyText(Buffer.from("hello world")), true);
  assert.equal(isProbablyText(Buffer.from([104, 0, 105])), false);
  assert.equal(isProbablyText(Buffer.alloc(0)), true);
});

test("isProbablyText only samples the first 8000 bytes", () => {
  const buffer = Buffer.alloc(9000, 0x61);
  buffer[8500] = 0;
  assert.equal(isProbablyText(buffer), true, "NUL beyond the 8000-byte sample must not flip the verdict");
});

test("textDigest returns the sha256 hex of the input", () => {
  assert.equal(
    textDigest("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("textSummary reports chars, lines, and sha256", () => {
  assert.deepEqual(textSummary("a\nb\nc"), {
    chars: 5,
    lines: 3,
    sha256: textDigest("a\nb\nc"),
  });
});

test("textSummary reports zero lines for an empty string", () => {
  assert.deepEqual(textSummary(""), {
    chars: 0,
    lines: 0,
    sha256: textDigest(""),
  });
});
