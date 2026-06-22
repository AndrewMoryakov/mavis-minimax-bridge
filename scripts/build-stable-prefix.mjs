#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argValues(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

function argValue(name, fallback) {
  const values = argValues(name);
  return values.length > 0 ? values[values.length - 1] : fallback;
}

function walkFiles(target) {
  const resolved = path.resolve(repoRoot, target);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];
  if (!stat.isDirectory()) return [];
  const allowed = new Set([".md", ".json", ".mjs"]);
  return fs.readdirSync(resolved, { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(resolved, entry.name);
      if (entry.isDirectory()) return walkFiles(path.relative(repoRoot, child));
      if (entry.isFile() && allowed.has(path.extname(entry.name))) return [child];
      return [];
    });
}

const outPath = path.resolve(repoRoot, argValue("--out", "stable-prefix.local.txt"));
const includes = argValues("--include");
const defaultIncludes = ["README.md", "docs", "examples/config.example.json", "package.json"];
const files = [...new Set((includes.length > 0 ? includes : defaultIncludes).flatMap(walkFiles))]
  .filter((file) => !path.basename(file).endsWith(".local.txt"))
  .sort((a, b) => a.localeCompare(b));

const sections = [
  "# Stable Prefix Canary",
  "",
  "This file is generated for MiniMax prompt-cache canaries.",
  "It should contain realistic, repeatable project context.",
  "",
  ...files.flatMap((file) => {
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    const text = fs.readFileSync(file, "utf8").trim();
    return [
      `## FILE: ${rel}`,
      "",
      "```text",
      text,
      "```",
      "",
    ];
  }),
];

fs.writeFileSync(outPath, `${sections.join("\n")}\n`, "utf8");
const bytes = Buffer.byteLength(fs.readFileSync(outPath), "utf8");
console.log(JSON.stringify({
  outPath,
  files: files.map((file) => path.relative(repoRoot, file).replace(/\\/g, "/")),
  bytes,
  estimatedTokens: Math.ceil(bytes / 4),
}, null, 2));
