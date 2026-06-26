#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(scriptRepoRoot, "prompts", "bridge.md");
const args = new Map();

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "1");
  } else {
    args.set(key, next);
    i += 1;
  }
}

if (args.has("help") || args.has("h")) {
  console.log(`Install the bridge custom prompt into Codex

Usage:
  node .\\scripts\\install-codex-slash.mjs [--codex-home <path>] [--dry-run]

Default target:
  %USERPROFILE%\\.codex\\prompts\\bridge.md

After install, restart Codex CLI and use:
  /prompts:bridge status
`);
  process.exit(0);
}

const codexHome = path.resolve(args.get("codex-home") ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
const target = path.join(codexHome, "prompts", "bridge.md");
const dryRun = args.has("dry-run");

if (!fs.existsSync(source)) {
  console.error(`source missing: ${source}`);
  process.exit(1);
}

const sourceText = fs.readFileSync(source, "utf8");
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

if (current === sourceText) {
  console.log(`codex_slash_unchanged=${target}`);
  process.exit(0);
}

if (current !== null) {
  const backupDir = path.join(path.dirname(target), "backups");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backup = path.join(backupDir, `bridge.before-bridge-install.${stamp}.md`);
  if (!dryRun) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(target, backup);
  }
  console.log(`${dryRun ? "would_backup" : "backup"}=${backup}`);
}

if (!dryRun) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sourceText, "utf8");
}

console.log(`${dryRun ? "would_install_codex_slash" : "installed_codex_slash"}=${target}`);
