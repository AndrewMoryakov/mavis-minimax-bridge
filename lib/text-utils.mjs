import { createHash } from "node:crypto";

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return !sample.includes(0);
}

export function textDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function textSummary(text) {
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    sha256: textDigest(text),
  };
}
