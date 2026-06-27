import fs from "node:fs";

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

export function readJsonFromString(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readJsonl(filePath, limit = 50) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/)
    .slice(-limit)
    .map((line) => readJsonFromString(line, null))
    .filter(Boolean);
}

export function escapeNonAscii(text) {
  return text.replace(/[^\x00-\x7F]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}
