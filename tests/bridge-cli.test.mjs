import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBridge = path.join(repoRoot, "bridge.mjs");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-test-"));
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sandboxWithSpace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mavis bridge parent-"));
  const dir = path.join(parent, "bridge repo with space");
  fs.mkdirSync(dir);
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, "utf8");
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

function runBridge(dir, args, options = {}) {
  return runBridgeScript(path.join(dir, "bridge.mjs"), dir, args, options);
}

function runBridgeScript(scriptPath, cwd, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: options.env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    text: `${result.stdout}${result.stderr}`,
  };
}

function ok(result) {
  assert.equal(result.status, 0, result.text);
  return JSON.parse(result.stdout);
}

function fails(result, pattern) {
  assert.notEqual(result.status, 0, result.text);
  assert.match(result.text, pattern);
}

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result;
}

test("duet lifecycle redacts by default and exposes text only with --raw", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_DUET_TEST_123";
  writeFile(dir, "goal.md", `Goal ${secret}`);
  writeFile(dir, "handoff.md", `Handoff ${secret}`);
  writeFile(dir, "note.md", `Note ${secret}`);

  const init = runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "4"]);
  assert.equal(init.status, 0, init.text);
  assert.doesNotMatch(init.text, new RegExp(secret));

  const pass = runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]);
  assert.equal(pass.status, 0, pass.text);
  assert.doesNotMatch(pass.text, new RegExp(secret));

  const note = runBridge(dir, ["duet", "note", "--agent", "minimax", "--note", "note.md"]);
  assert.equal(note.status, 0, note.text);
  assert.doesNotMatch(note.text, new RegExp(secret));

  const show = ok(runBridge(dir, ["duet", "show"]));
  assert.equal(show.state.status, "running");
  assert.equal(show.state.baton, "minimax");
  assert.equal(show.state.iteration, 2);
  assert.equal(show.raw, false);
  assert.doesNotMatch(JSON.stringify(show), new RegExp(secret));
  assert.equal(typeof show.state.goal.sha256, "string");
  assert.equal(typeof show.journal.sha256, "string");

  const rawShow = ok(runBridge(dir, ["duet", "show", "--raw"]));
  assert.equal(rawShow.raw, true);
  assert.match(JSON.stringify(rawShow), new RegExp(secret));
});

test("raw mutating duet commands expose local text only when explicitly requested", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_RAW_MUTATION_456";
  writeFile(dir, "goal.md", `Goal ${secret}`);
  writeFile(dir, "handoff.md", `Handoff ${secret}`);
  writeFile(dir, "note.md", `Note ${secret}`);

  const init = ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--raw"]));
  assert.equal(init.raw, true);
  assert.match(JSON.stringify(init), new RegExp(secret));

  const pass = ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md", "--raw"]));
  assert.equal(pass.raw, true);
  assert.match(JSON.stringify(pass), new RegExp(secret));

  const note = ok(runBridge(dir, ["duet", "note", "--agent", "minimax", "--note", "note.md", "--raw"]));
  assert.equal(note.raw, true);
  assert.match(JSON.stringify(note), new RegExp(secret));
});

test("duet transcript export redacts by default and raw export requires explicit raw", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_TRANSCRIPT_EXPORT_789";
  writeFile(dir, "goal.md", `Goal ${secret}`);
  writeFile(dir, "handoff.md", `Handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const redacted = ok(runBridge(dir, ["duet", "transcript", "export"]));
  assert.equal(redacted.event, "duet-transcript-export");
  assert.equal(redacted.raw, false);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(secret));
  assert.equal(typeof redacted.state.goal.sha256, "string");
  assert.equal(typeof redacted.journal.sha256, "string");

  const raw = ok(runBridge(dir, ["duet", "transcript", "export", "--raw"]));
  assert.equal(raw.raw, true);
  assert.match(JSON.stringify(raw), new RegExp(secret));
});

test("duet transcript export supports markdown output and protects raw output paths", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_TRANSCRIPT_MARKDOWN_101";
  writeFile(dir, "goal.md", `Goal ${secret}`);
  writeFile(dir, "handoff.md", `Handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--status", "done", "--handoff", "handoff.md"]));

  const out = ok(runBridge(dir, [
    "duet",
    "transcript",
    "export",
    "--format",
    "markdown",
    "--out",
    "transcript.local.md",
  ]));
  assert.equal(out.event, "duet-transcript-export");
  assert.equal(out.format, "markdown");
  const markdown = fs.readFileSync(path.join(dir, "transcript.local.md"), "utf8");
  assert.match(markdown, /# Duet Transcript Export/);
  assert.doesNotMatch(markdown, new RegExp(secret));

  fails(
    runBridge(dir, ["duet", "transcript", "export", "--raw", "--out", "transcript.md"]),
    /--raw --out requires a \.local\.\* output path/,
  );

  const rawOut = ok(runBridge(dir, ["duet", "transcript", "export", "--raw", "--out", "transcript.local.json"]));
  assert.equal(rawOut.raw, true);
  assert.match(fs.readFileSync(path.join(dir, "transcript.local.json"), "utf8"), new RegExp(secret));
});

test("duet verify runs node verifier with redacted output by default and raw output when requested", (t) => {
  const dir = sandbox(t);
  const secret = "VERIFY_SECRET_SHOULD_BE_RAW_ONLY";
  writeFile(dir, "verify.mjs", `console.log(${JSON.stringify(secret)}); console.error("ERR_LINE");`);

  const redacted = ok(runBridge(dir, ["duet", "verify", "--verifier", "verify.mjs"]));
  assert.equal(redacted.event, "duet-verify");
  assert.equal(redacted.status, "ok");
  assert.equal(redacted.exitCode, 0);
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.stdout.mode, "redacted");
  assert.equal(typeof redacted.stdout.sha256, "string");
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(secret));

  const raw = ok(runBridge(dir, ["duet", "verify", "--verifier", "verify.mjs", "--raw"]));
  assert.equal(raw.raw, true);
  assert.equal(raw.stdout.mode, "raw");
  assert.match(raw.stdout.text, new RegExp(secret));
  assert.match(raw.stderr.text, /ERR_LINE/);
});

test("duet verify reports failures, forwards args after separator, and rejects unsafe inputs", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "args.mjs", "console.log(JSON.stringify(process.argv.slice(2)));");
  writeFile(dir, "fail.mjs", "console.error('FAIL_STDERR_SECRET'); process.exit(7);");
  writeFile(dir, "bad.txt", "console.log('bad');");
  writeFile(dir, "large.mjs", "x".repeat(256 * 1024 + 1));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-verify-outside-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeFile(other, "outside.mjs", "console.log('outside');");

  const argsRun = ok(runBridge(dir, ["duet", "verify", "--verifier", "args.mjs", "--raw", "--", "--fast", "name=value"]));
  assert.deepEqual(JSON.parse(argsRun.stdout.text.trim()), ["--fast", "name=value"]);

  const failed = ok(runBridge(dir, ["duet", "verify", "--verifier", "fail.mjs"]));
  assert.equal(failed.status, "fail");
  assert.equal(failed.exitCode, 7);
  assert.doesNotMatch(JSON.stringify(failed), /FAIL_STDERR_SECRET/);

  fails(runBridge(dir, ["duet", "verify", "--verifier", "missing.mjs"]), /verifier file not found/);
  fails(runBridge(dir, ["duet", "verify", "--verifier", "large.mjs"]), /verifier file too large/);
  fails(runBridge(dir, ["duet", "verify", "--verifier", "bad.txt"]), /\.js, \.mjs, or \.cjs/);
  fails(runBridge(dir, ["duet", "verify", "--verifier", path.join(other, "outside.mjs")]), /escapes bridge root/);
  fails(
    runBridge(dir, ["duet", "verify", "--verifier", "args.mjs", "--", ...Array.from({ length: 257 }, (_, index) => `arg-${index}`)]),
    /too many verifier args/,
  );
});

test("duet verify runs with a minimal environment", (t) => {
  const dir = sandbox(t);
  writeFile(
    dir,
    "env.mjs",
    "console.log(JSON.stringify({ home: process.env.HOME, userprofile: process.env.USERPROFILE, mavis: process.env.MAVIS_SECRET, nodeOptions: process.env.NODE_OPTIONS }));",
  );

  const env = { ...process.env, HOME: "HOME_SECRET", USERPROFILE: "PROFILE_SECRET", MAVIS_SECRET: "MAVIS_SECRET", NODE_OPTIONS: "" };
  const result = ok(runBridge(dir, ["duet", "verify", "--verifier", "env.mjs", "--raw"], { env }));
  const childEnv = JSON.parse(result.stdout.text.trim());
  assert.deepEqual(childEnv, { home: "", userprofile: "", nodeOptions: "" });
});

test("duet verify enforces timeout", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "hang.mjs", "setInterval(() => {}, 1000);");

  const timedOut = ok(runBridge(dir, ["duet", "verify", "--verifier", "hang.mjs", "--timeout-sec", "1"]));
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.signal, "timeout");
});

test("duet verify record appends compact journal note only for active relay", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Verify record goal");
  writeFile(dir, "done.md", "Done");
  writeFile(dir, "verify.mjs", "console.log('VERIFY_RECORD_SECRET');");

  fails(runBridge(dir, ["duet", "verify", "--verifier", "verify.mjs", "--record", "--agent", "codex"]), /duet state is not initialized/);
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex"]));

  const recorded = ok(runBridge(dir, ["duet", "verify", "--verifier", "verify.mjs", "--record", "--agent", "codex"]));
  assert.equal(recorded.record.appended, true);
  const journal = fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8");
  assert.match(journal, /Verify - codex/);
  assert.match(journal, /status=ok/);
  assert.doesNotMatch(journal, /VERIFY_RECORD_SECRET/);

  fails(runBridge(dir, ["duet", "verify", "--verifier", "verify.mjs", "--raw", "--record", "--agent", "codex"]), /--raw cannot be combined with --record/);
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--status", "done", "--handoff", "done.md"]));
  fails(runBridge(dir, ["duet", "verify", "--verifier", "verify.mjs", "--record", "--agent", "codex"]), /cannot record verify result when duet status is done/);
});

test("duet done state blocks further passes without --force", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Finishable goal");
  writeFile(dir, "handoff.md", "Finished handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "3"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "minimax", "--status", "done", "--handoff", "handoff.md"]));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "done");
  assert.equal(state.baton, null);

  fails(
    runBridge(dir, ["duet", "pass", "--from", "minimax", "--to", "codex", "--handoff", "handoff.md"]),
    /duet status is done/,
  );
});

test("duet explicit human escalation stores the handoff and blocks further passes", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Escalation goal");
  writeFile(dir, "handoff.md", "Need human decision");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "3"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--status", "human_escalation", "--handoff", "handoff.md"]));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "human_escalation");
  assert.equal(state.baton, null);
  assert.equal(state.humanEscalation, "Need human decision");

  fails(
    runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]),
    /duet status is human_escalation/,
  );
});

test("maxIterations stops relay without incrementing past the limit", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Limit goal");
  writeFile(dir, "handoff.md", "Limit handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "1"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "human_escalation");
  assert.equal(state.iteration, 1);
  assert.equal(state.maxIterations, 1);
  assert.equal(state.baton, null);
  assert.equal(state.humanEscalation, "maxIterations reached (1)");
});

test("duet rejects wrong baton and invalid agent names", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Baton goal");
  writeFile(dir, "handoff.md", "Baton handoff");
  writeFile(dir, "note.md", "Baton note");

  fails(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "someone"]), /--baton must be one of/);
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex"]));

  fails(runBridge(dir, ["duet", "pass", "--from", "minimax", "--handoff", "handoff.md"]), /baton is held by codex/);
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "someone", "--handoff", "handoff.md"]), /--to must be one of/);
  fails(runBridge(dir, ["duet", "note", "--agent", "someone", "--note", "note.md"]), /--agent must be one of/);
});

test("duet validates bad inputs and damaged runtime state", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Validation goal");
  writeFile(dir, "handoff.md", "Validation handoff");
  writeFile(dir, "too-large.md", "x".repeat(20001));

  fails(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "nope"]), /positive integer/);
  fails(runBridge(dir, ["duet", "init", "--goal", "too-large.md"]), /file is too large/);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "2"]));
  fails(runBridge(dir, ["duet", "init", "--goal", "goal.md"]), /already exists/);

  fs.writeFileSync(
    path.join(dir, "duet-state.json"),
    JSON.stringify({ goal: "x", baton: "codex", iteration: 1, status: "running", lastHandoff: "", humanEscalation: null }),
    "utf8",
  );
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /invalid duet state: maxIterations/);

  fs.writeFileSync(path.join(dir, "duet-state.json"), "{not-json", "utf8");
  fails(runBridge(dir, ["duet", "show"]), /duet state is not valid JSON/);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "2", "--force"]));
  fs.rmSync(path.join(dir, "duet-journal.md"));
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /duet journal is missing/);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "2", "--force"]));
  fs.writeFileSync(path.join(dir, "duet-journal.md"), "   \n", "utf8");
  fails(runBridge(dir, ["duet", "show"]), /duet journal is empty/);
});

test("duet lock blocks overlapping mutating commands and stale lock is cleared", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Lock goal");
  writeFile(dir, "handoff.md", "Lock handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "3"]));
  const lockPath = path.join(dir, "duet.lock");
  fs.writeFileSync(lockPath, "held", "utf8");
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /duet lock is held/);

  const stale = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, stale, stale);
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));
  assert.equal(readJson(dir, "duet-state.json").baton, "minimax");
});

test("duet lock is cleaned up after failed mutating commands", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Cleanup goal");
  writeFile(dir, "handoff.md", "Cleanup handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));
  fails(runBridge(dir, ["duet", "pass", "--from", "minimax", "--handoff", "handoff.md"]), /baton is held by codex/);
  assert.equal(fs.existsSync(path.join(dir, "duet.lock")), false);

  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));
  assert.equal(readJson(dir, "duet-state.json").baton, "minimax");
});

test("safe local commands work in an isolated runtime directory", (t) => {
  const dir = sandbox(t);

  assert.equal(runBridge(dir, ["help"]).status, 0);
  assert.equal(ok(runBridge(dir, ["doctor"])).event, "doctor");
  assert.equal(runBridge(dir, ["duet", "help"]).status, 0);
  assert.equal(ok(runBridge(dir, ["config", "show"])).event, "config");
  assert.equal(ok(runBridge(dir, ["mode", "list"])).event, "mode");
  assert.equal(ok(runBridge(dir, ["session", "show"])).event, "session");
  assert.equal(ok(runBridge(dir, ["deny-session", "list"])).event, "deny-session");
  assert.equal(ok(runBridge(dir, ["token-stats", "--ledger", "--lines", "5"])).event, "token-stats");
});

test("doctor is local-only and warns when optional sentinels are absent", (t) => {
  const dir = sandbox(t);

  const report = ok(runBridge(dir, ["doctor"]));
  assert.equal(report.event, "doctor");
  assert.equal(report.cwdMatchesExpectedRoot, true);
  assert.equal(report.verdict, "warn");
  assert.equal(report.sentinels.find((item) => item.relativePath === "bridge.mjs").exists, true);
  assert.equal(fs.existsSync(path.join(dir, "ledger.jsonl")), false);
});

test("doctor reports invalid config without crashing", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxTurns: 999 }), "utf8");

  const report = ok(runBridge(dir, ["doctor"]));
  assert.equal(report.event, "doctor");
  assert.equal(report.config.loaded, false);
  assert.equal(report.verdict, "fail");
  assert.match(report.config.error, /maxTurns/);
  assert.equal(fs.existsSync(path.join(dir, "ledger.jsonl")), false);
});

test("workspace guard blocks sensitive commands from the wrong cwd without writing runtime files", (t) => {
  const dir = sandbox(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeFile(dir, "goal.md", "Wrong cwd goal");
  writeFile(dir, "task.md", "Wrong cwd task");
  writeFile(dir, "long.txt", "Wrong cwd long prompt");

  const script = path.join(dir, "bridge.mjs");
  fails(runBridgeScript(script, other, ["duet", "init", "--goal", "goal.md"]), /workspace guard blocked duet/);
  fails(runBridgeScript(script, other, ["ask", "--dry-run", "--task", "task.md"]), /workspace guard blocked ask/);
  fails(runBridgeScript(script, other, ["canary-estimate", "--long-prompt", "long.txt"]), /workspace guard blocked canary-estimate/);

  assert.equal(fs.existsSync(path.join(dir, "duet-state.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "inbox.jsonl")), false);
  assert.equal(fs.existsSync(path.join(dir, "ledger.jsonl")), false);
});

test("workspace guard keeps help and doctor usable from the wrong cwd", (t) => {
  const dir = sandbox(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const script = path.join(dir, "bridge.mjs");

  assert.equal(runBridgeScript(script, other, ["duet", "help"]).status, 0);
  const report = ok(runBridgeScript(script, other, ["doctor"]));
  assert.equal(report.event, "doctor");
  assert.equal(report.cwdMatchesExpectedRoot, false);
  assert.equal(report.verdict, "fail");
  assert.match(report.nextCommand, /Set-Location/);
  assert.equal(fs.existsSync(path.join(dir, "ledger.jsonl")), false);
});

test("ask dry-run attaches dirty worktree source context by default", (t) => {
  const dir = sandbox(t);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Bridge Test"]);
  writeFile(dir, "tracked.txt", "before\n");
  git(dir, ["add", "bridge.mjs", "tracked.txt"]);
  git(dir, ["commit", "-m", "seed"]);

  writeFile(dir, "task.md", "Review local changes.");
  writeFile(dir, "tracked.txt", "before\nafter\n");
  writeFile(dir, "new-feature.txt", "UNTRACKED_SOURCE_VISIBILITY_SENTINEL\n");
  writeFile(dir, "unicode-\u03a9-source.txt", "UNICODE_UNTRACKED_SENTINEL\n");

  const dryRun = ok(runBridge(dir, ["ask", "--dry-run", "--mode", "review-only", "--task", "task.md", "--raw"]));
  assert.equal(dryRun.event, "ask-dry-run");
  assert.equal(dryRun.sourceContext.included, true);
  assert.equal(dryRun.sourceContext.reason, "dirty worktree");
  assert.equal(dryRun.sourceContext.untrackedCount, 2);
  assert.match(dryRun.sourceContext.text, /git status --short/);
  assert.match(dryRun.sourceContext.text, /tracked\.txt/);
  assert.match(dryRun.sourceContext.text, /new-feature\.txt/);
  assert.match(dryRun.sourceContext.text, /UNTRACKED_SOURCE_VISIBILITY_SENTINEL/);
  assert.match(dryRun.sourceContext.text, /UNICODE_UNTRACKED_SENTINEL/);
  assert.match(dryRun.prompts[0].text, /<source_context/);
});

test("ask dry-run can disable source context", (t) => {
  const dir = sandbox(t);
  git(dir, ["init"]);
  writeFile(dir, "task.md", "Review without source context.");
  writeFile(dir, "untracked.txt", "SHOULD_NOT_APPEAR\n");

  const dryRun = ok(runBridge(dir, ["ask", "--dry-run", "--mode", "review-only", "--task", "task.md", "--source-context", "off", "--raw"]));
  assert.equal(dryRun.sourceContext.included, false);
  assert.equal(dryRun.sourceContext.reason, "disabled");
  assert.doesNotMatch(dryRun.prompts[0].text, /<source_context/);
  assert.doesNotMatch(JSON.stringify(dryRun), /SHOULD_NOT_APPEAR/);
});

test("ask dry-run can include explicit source from a clean worktree", (t) => {
  const dir = sandbox(t);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Bridge Test"]);
  fs.mkdirSync(path.join(dir, "src"));
  writeFile(dir, "task.md", "Review explicit includes.");
  writeFile(dir, "src/alpha.txt", "EXPLICIT_INCLUDE_ALPHA\n");
  writeFile(dir, "src/beta.txt", "EXPLICIT_INCLUDE_BETA\n");
  git(dir, ["add", "bridge.mjs", "task.md", "src/alpha.txt", "src/beta.txt"]);
  git(dir, ["commit", "-m", "seed"]);

  const dryRun = ok(runBridge(dir, [
    "ask",
    "--dry-run",
    "--mode",
    "review-only",
    "--task",
    "task.md",
    "--include",
    "src",
    "--raw",
  ]));
  assert.equal(dryRun.sourceContext.included, true);
  assert.equal(dryRun.sourceContext.reason, "explicit include");
  assert.equal(dryRun.sourceContext.includeCount, 2);
  assert.equal(dryRun.sourceContext.untrackedCount, 0);
  assert.match(dryRun.sourceContext.text, /explicit include text file snippets/);
  assert.match(dryRun.sourceContext.text, /EXPLICIT_INCLUDE_ALPHA/);
  assert.match(dryRun.sourceContext.text, /EXPLICIT_INCLUDE_BETA/);
});

test("ask include excludes task files, runtime files, and binary files", (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, "src"));
  writeFile(dir, "src/task.md", "TASK_SECRET_SHOULD_NOT_BE_IN_SOURCE_CONTEXT\n");
  writeFile(dir, "src/context.txt", "EXPLICIT_CONTEXT_VISIBLE\n");
  writeFile(dir, "src/note.local.md", "LOCAL_SECRET_SHOULD_NOT_APPEAR\n");
  writeFile(dir, "src/ledger.jsonl", "RUNTIME_SECRET_SHOULD_NOT_APPEAR\n");
  fs.writeFileSync(path.join(dir, "src/blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));

  const dryRun = ok(runBridge(dir, [
    "ask",
    "--dry-run",
    "--mode",
    "review-only",
    "--task",
    "src/task.md",
    "--include",
    "src",
    "--raw",
  ]));
  assert.equal(dryRun.sourceContext.included, true);
  assert.equal(dryRun.sourceContext.reason, "explicit include");
  assert.equal(dryRun.sourceContext.includeCount, 1);
  assert.equal(dryRun.sourceContext.includeSkippedCount, 4);
  assert.match(dryRun.sourceContext.text, /EXPLICIT_CONTEXT_VISIBLE/);
  assert.match(dryRun.sourceContext.text, /binary-looking file/);
  assert.doesNotMatch(dryRun.sourceContext.text, /TASK_SECRET_SHOULD_NOT_BE_IN_SOURCE_CONTEXT/);
  assert.doesNotMatch(dryRun.sourceContext.text, /LOCAL_SECRET_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(dryRun.sourceContext.text, /RUNTIME_SECRET_SHOULD_NOT_APPEAR/);
});

test("ask include validates source context mode and path boundaries", (t) => {
  const dir = sandbox(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-include-outside-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeFile(dir, "task.md", "Review include validation.");
  writeFile(dir, "context.txt", "Visible only when include is valid.");
  writeFile(other, "outside.txt", "OUTSIDE_SECRET_SHOULD_NOT_APPEAR\n");

  fails(
    runBridge(dir, ["ask", "--dry-run", "--task", "task.md", "--include", "context.txt", "--source-context", "off"]),
    /--include cannot be used with --source-context off/,
  );
  fails(
    runBridge(dir, ["ask", "--dry-run", "--task", "task.md", "--include", "missing.txt"]),
    /--include path not found/,
  );
  fails(
    runBridge(dir, ["ask", "--dry-run", "--task", "task.md", "--include", path.join(other, "outside.txt")]),
    /--include path escapes bridge root/,
  );
});

test("ask include handles symlink escapes and repeated in-root directories", (t) => {
  const dir = sandbox(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-include-symlink-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"));
  writeFile(dir, "task.md", "Review symlink handling.");
  writeFile(dir, "src/context.txt", "SYMLINK_LOOP_CONTEXT_VISIBLE\n");
  writeFile(other, "outside.txt", "SYMLINK_OUTSIDE_SECRET_SHOULD_NOT_APPEAR\n");

  try {
    fs.symlinkSync(path.join(other, "outside.txt"), path.join(dir, "src", "outside-link.txt"), "file");
    fs.symlinkSync(path.join(dir, "src"), path.join(dir, "src", "self-link"), "junction");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.message}`);
    return;
  }

  fails(
    runBridge(dir, ["ask", "--dry-run", "--task", "task.md", "--include", "src/outside-link.txt"]),
    /--include path escapes bridge root/,
  );

  const dryRun = ok(runBridge(dir, [
    "ask",
    "--dry-run",
    "--task",
    "task.md",
    "--include",
    "src",
    "--raw",
  ]));
  assert.equal(dryRun.sourceContext.included, true);
  assert.match(dryRun.sourceContext.text, /SYMLINK_LOOP_CONTEXT_VISIBLE/);
  assert.match(dryRun.sourceContext.text, /already visited/);
  assert.doesNotMatch(dryRun.sourceContext.text, /SYMLINK_OUTSIDE_SECRET_SHOULD_NOT_APPEAR/);
});

test("ask include caps broad directory traversal", (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, "many"));
  writeFile(dir, "task.md", "Review capped include.");
  for (let index = 0; index < 95; index += 1) {
    writeFile(dir, `many/file-${String(index).padStart(3, "0")}.txt`, `CAP_FILE_${index}\n`);
  }

  const dryRun = ok(runBridge(dir, [
    "ask",
    "--dry-run",
    "--task",
    "task.md",
    "--include",
    "many",
    "--raw",
  ]));
  assert.equal(dryRun.sourceContext.includeCount, 80);
  assert.equal(dryRun.sourceContext.includeLimits.fileLimitReached, true);
  assert.match(dryRun.sourceContext.text, /file limit reached \(80\)/);
});

test("state command reports duet runtime files when they exist", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "State visibility goal");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));
  const state = ok(runBridge(dir, ["state"]));
  assert.equal(state.runtimeFiles.duetState.exists, true);
  assert.equal(state.runtimeFiles.duetJournal.exists, true);
  assert.equal(state.runtimeFiles.duetLock.exists, false);
});

test("duet runtime files are written to the real directory when path contains spaces", (t) => {
  const dir = sandboxWithSpace(t);
  writeFile(dir, "goal.md", "Path with spaces goal");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));
  assert.equal(fs.existsSync(path.join(dir, "duet-state.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "duet-journal.md")), true);
  assert.equal(fs.existsSync(path.join(dir.replaceAll(" ", "%20"), "duet-state.json")), false);

  const state = ok(runBridge(dir, ["state"]));
  assert.equal(state.runtimeFiles.duetState.exists, true);
  assert.doesNotMatch(state.runtimeFiles.duetState.path, /%20/);
});

test("runtime files, duet temp files, and local scratch files are git-ignored", () => {
  const samples = [
    "ledger.jsonl",
    "outbox.jsonl",
    "duet-state.json",
    "duet-journal.md",
    "duet.lock",
    "duet-state.json.123.tmp",
    "duet-journal.md.123.tmp",
    "handoff.local.md",
    "live-smoke-tetris-zero-20260627/index.html",
  ];

  for (const sample of samples) {
    const result = spawnSync("git", ["check-ignore", "-v", sample], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${sample} is not ignored\n${result.stdout}${result.stderr}`);
  }
});

test("installable skill and prompt surfaces document duet relay", () => {
  const files = [
    "skills/bridge/SKILL.md",
    "skills/codex-bridge/SKILL.md",
    "prompts/bridge.md",
    "README.md",
    "docs/COMMANDS.md",
    "docs/DUET_RELAY.md",
    "docs/LETS_GO.md",
    "docs/RUNTIME_FILES.md",
  ];

  for (const relative of files) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /duet|Duet/, `${relative} should mention Duet`);
  }

  for (const relative of ["skills/bridge/SKILL.md", "skills/codex-bridge/SKILL.md", "prompts/bridge.md", "docs/LETS_GO.md"]) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /let's go/, `${relative} should document the natural-language start`);
    assert.match(text, /does not wake, message, or\s+activate/, `${relative} should clarify that relay does not auto-activate the other agent`);
  }
});
