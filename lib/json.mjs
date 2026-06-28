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
  const records = [];
  for (const line of text.split(/\r?\n/).slice(-limit)) {
    const parsed = readJsonFromString(line, null);
    if (parsed) {
      records.push(parsed);
      continue;
    }
    if (line.trim()) {
      process.emitWarning(`skipped invalid JSONL line in ${filePath}`, { code: "MAVIS_BRIDGE_JSONL_PARSE" });
    }
  }
  return records;
}

export function escapeNonAscii(text) {
  return text.replace(/[^\x00-\x7F]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}
