#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(scriptRepoRoot, "skills", "codex-bridge", "SKILL.md");
const args = new Map();
const allowedArgs = new Set(["codex-home", "repo-root", "dry-run", "help", "h"]);

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  if (!allowedArgs.has(key)) {
    console.error(`unknown option: --${key}`);
    process.exit(1);
  }
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "1");
  } else {
    args.set(key, next);
    i += 1;
  }
}

if (args.has("help") || args.has("h")) {
  console.log(`Install the bridge skill into Codex

Usage:
  node .\\scripts\\install-codex-skill.mjs [--codex-home <path>] [--repo-root <path>] [--dry-run]

Default target:
  %USERPROFILE%\\.codex\\skills\\mavis-minimax-bridge\\SKILL.md
`);
  process.exit(0);
}

const codexHome = path.resolve(args.get("codex-home") ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
const target = path.join(codexHome, "skills", "mavis-minimax-bridge", "SKILL.md");
const dryRun = args.has("dry-run");
const repoRoot = path.resolve(args.get("repo-root") ?? scriptRepoRoot);

if (!fs.existsSync(source)) {
  console.error(`source missing: ${source}`);
  process.exit(1);
}

const sourceText = fs.readFileSync(source, "utf8").replaceAll("__BRIDGE_REPO_ROOT__", repoRoot);
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

if (current === sourceText) {
  console.log(`codex_skill_unchanged=${target}`);
  process.exit(0);
}

if (current !== null) {
  const backupDir = path.join(path.dirname(target), "backups");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backup = path.join(backupDir, `SKILL.before-bridge-install.${stamp}.md`);
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

console.log(`${dryRun ? "would_install_codex_skill" : "installed_codex_skill"}=${target}`);
