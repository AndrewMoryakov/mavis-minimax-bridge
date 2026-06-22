#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const targetDir = path.resolve(argValue("--target", repoRoot));
const force = args.includes("--force");
const emptyJsonl = args.includes("--empty-jsonl");

function copyRuntimeFile(name, options = {}) {
  const source = path.join(repoRoot, "scaffold", name);
  const dest = path.join(targetDir, name);
  if (fs.existsSync(dest) && !force) {
    return { file: name, status: "kept", path: dest };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (options.empty) {
    fs.writeFileSync(dest, "", "utf8");
  } else {
    fs.copyFileSync(source, dest);
  }
  return { file: name, status: fs.existsSync(dest) && force ? "written" : "created", path: dest };
}

const results = [
  copyRuntimeFile("config.json"),
  copyRuntimeFile("ledger.jsonl", { empty: emptyJsonl }),
  copyRuntimeFile("inbox.jsonl", { empty: emptyJsonl }),
  copyRuntimeFile("outbox.jsonl", { empty: emptyJsonl }),
];

console.log(JSON.stringify({
  targetDir,
  force,
  emptyJsonl,
  files: results,
}, null, 2));
