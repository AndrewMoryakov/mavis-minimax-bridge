import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBridge = path.join(repoRoot, "bridge.mjs");
const sourceLib = path.join(repoRoot, "lib");

function copyBridgeRuntimeFiles(dir) {
  fs.copyFileSync(sourceBridge, path.join(dir, "bridge.mjs"));
  if (fs.existsSync(sourceLib)) {
    fs.cpSync(sourceLib, path.join(dir, "lib"), { recursive: true });
  }
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-test-"));
  copyBridgeRuntimeFiles(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sandboxWithSpace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mavis bridge parent-"));
  const dir = path.join(parent, "bridge repo with space");
  fs.mkdirSync(dir);
  copyBridgeRuntimeFiles(dir);
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

function jsonOutput(result) {
  assert.ok(result.stdout.trim(), result.text);
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

function bridgeRuntimeGitPaths(dir) {
  return fs.existsSync(path.join(dir, "lib")) ? ["bridge.mjs", "lib"] : ["bridge.mjs"];
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

test("duet start initializes relay and returns a safe launch packet", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_DUET_START_123";
  writeFile(dir, "goal.md", `Start goal ${secret}`);
  writeFile(dir, "verify.mjs", "console.log('ok');");

  const start = runBridge(dir, [
    "duet",
    "start",
    "--goal",
    "goal.md",
    "--baton",
    "minimax",
    "--max-iterations",
    "6",
    "--max-rounds",
    "3",
    "--max-codex-steps",
    "2",
    "--max-minimax-steps",
    "2",
    "--max-tokens",
    "12345",
    "--verifier",
    "verify.mjs",
  ]);
  assert.equal(start.status, 0, start.text);
  assert.doesNotMatch(start.text, new RegExp(secret));
  const payload = JSON.parse(start.stdout);
  assert.equal(payload.event, "duet-start");
  assert.equal(payload.tokenSpending, false);
  assert.equal(payload.state.status, "running");
  assert.equal(payload.state.baton, "minimax");
  assert.equal(payload.state.maxIterations, 6);
  assert.match(payload.commands.preflight, /duet loop --dry-run/);
  assert.match(payload.commands.preflight, /--max-tokens 12345/);
  assert.match(payload.commands.preflight, /--verifier verify\.mjs/);
  assert.match(payload.commands.live, /duet loop --yes/);
  assert.match(payload.commands.report, /duet report/);

  const show = ok(runBridge(dir, ["duet", "show"]));
  assert.equal(show.state.baton, "minimax");
  assert.equal(show.state.iteration, 1);
  fails(runBridge(dir, ["duet", "start", "--goal", "goal.md"]), /duet state already exists/);
});

test("duet next reports baton, warnings, static actions, and redacts by default", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_DUET_NEXT_123";
  writeFile(dir, "goal.md", `Goal ${secret}`);
  writeFile(dir, "handoff.md", `Handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "3"]));
  const codexNext = ok(runBridge(dir, ["duet", "next", "--agent", "codex"]));
  assert.equal(codexNext.event, "duet-next");
  assert.equal(codexNext.status, "running");
  assert.equal(codexNext.baton, "codex");
  assert.equal(codexNext.agent, "codex");
  assert.equal(codexNext.allowedToAct, true);
  assert.equal(codexNext.warning, null);
  assert.deepEqual(codexNext.warnings, []);
  assert.match(codexNext.nextActions.act.join("\n"), /duet pass --from codex/);
  assert.doesNotMatch(JSON.stringify(codexNext), new RegExp(secret));

  const minimaxNext = ok(runBridge(dir, ["duet", "next", "--agent", "minimax"]));
  assert.equal(minimaxNext.allowedToAct, false);
  assert.equal(minimaxNext.warning, "wrong_baton");
  assert.match(minimaxNext.nextActions.recover.join("\n"), /duet pass --from codex --to minimax/);
  assert.doesNotMatch(JSON.stringify(minimaxNext), new RegExp(secret));

  const rawNext = ok(runBridge(dir, ["duet", "next", "--raw"]));
  assert.equal(rawNext.raw, true);
  assert.match(JSON.stringify(rawNext), new RegExp(secret));
});

test("duet next reports terminal states and latest verifier summary", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Next terminal goal");
  writeFile(dir, "handoff.md", "Done handoff");
  writeFile(dir, "verify with space.mjs", "console.log('ok');");

  fails(runBridge(dir, ["duet", "next"]), /duet state is not initialized/);
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "1"]));
  const recorded = ok(runBridge(dir, ["duet", "verify", "--verifier", "verify with space.mjs", "--record", "--agent", "codex"]));
  assert.equal(recorded.status, "ok");

  const limitNext = ok(runBridge(dir, ["duet", "next"]));
  assert.equal(limitNext.warning, "max_iterations_reached");
  assert.equal(limitNext.allowedToAct, false);
  assert.deepEqual(limitNext.nextActions.act, []);
  assert.equal(limitNext.lastVerifier.status, "ok");
  assert.equal(limitNext.lastVerifier.agent, "codex");
  assert.equal(limitNext.lastVerifier.verifier, "verify with space.mjs");

  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--status", "done", "--handoff", "handoff.md"]));
  const doneNext = ok(runBridge(dir, ["duet", "next", "--agent", "codex"]));
  assert.equal(doneNext.status, "done");
  assert.equal(doneNext.allowedToAct, false);
  assert.equal(doneNext.warning, "done");
  assert.deepEqual(doneNext.nextActions.act, []);
});

test("duet packet export is a redacted projection by default and supports raw local output", (t) => {
  const dir = sandbox(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-packet-outside-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const secret = "SECRET_PACKET_EXPORT_123";
  writeFile(dir, "goal.md", `Packet goal ${secret}`);
  writeFile(dir, "handoff.md", `Packet handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const redacted = ok(runBridge(dir, ["duet", "packet", "export", "--agent", "minimax"]));
  assert.equal(redacted.event, "duet-packet-export");
  assert.equal(redacted.raw, false);
  assert.equal(redacted.agent, "minimax");
  assert.equal(redacted.allowedToAct, true);
  assert.equal(redacted.projection.runtimeArtifact, false);
  assert.equal(redacted.projection.separateStateSchema, false);
  assert.equal(redacted.packet.overBudget, false);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(secret));

  const out = ok(runBridge(dir, [
    "duet",
    "packet",
    "export",
    "--agent",
    "minimax",
    "--format",
    "markdown",
    "--raw",
    "--out",
    "duet-packet.local.md",
  ]));
  assert.equal(out.event, "duet-packet-export");
  assert.equal(out.raw, true);
  const markdown = fs.readFileSync(path.join(dir, "duet-packet.local.md"), "utf8");
  assert.match(markdown, /# Duet Packet/);
  assert.match(markdown, new RegExp(secret));

  fails(
    runBridge(dir, ["duet", "packet", "export", "--agent", "minimax", "--raw", "--out", "duet-packet.md"]),
    /--raw --out requires a \.local\.\* output path/,
  );
  fails(
    runBridge(dir, ["duet", "packet", "export", "--agent", "minimax", "--out", path.join(other, "packet.local.json")]),
    /--out path escapes bridge root/,
  );

  try {
    fs.writeFileSync(path.join(other, "outside.md"), "outside", "utf8");
    fs.symlinkSync(path.join(other, "outside.md"), path.join(dir, "packet-link.local.md"), "file");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.message}`);
    return;
  }
  fails(
    runBridge(dir, ["duet", "packet", "export", "--agent", "minimax", "--raw", "--out", "packet-link.local.md"]),
    /--out must not target a symlink/,
  );
});

test("duet packet export validates agent and marks truncation visibly", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", `Long goal ${"x".repeat(3000)}`);
  writeFile(dir, "handoff.md", `Long handoff ${"y".repeat(3000)}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const codexPacket = ok(runBridge(dir, ["duet", "packet", "export", "--agent", "codex"]));
  assert.equal(codexPacket.event, "duet-packet-export");
  assert.equal(codexPacket.agent, "codex");
  assert.equal(codexPacket.allowedToAct, false);
  assert.equal(codexPacket.warning, "wrong_baton");
  const rawJson = ok(runBridge(dir, [
    "duet",
    "packet",
    "export",
    "--agent",
    "minimax",
    "--raw",
    "--max-packet-chars",
    "1000",
  ]));
  assert.equal(rawJson.raw, true);
  assert.equal(rawJson.state.goal.text, undefined);
  assert.equal(rawJson.goal.truncated, true);
  assert.match(rawJson.goal.text, /\[truncated: packet character budget reached\]/);

  const packet = runBridge(dir, [
    "duet",
    "packet",
    "export",
    "--agent",
    "minimax",
    "--format",
    "markdown",
    "--raw",
    "--max-packet-chars",
    "1000",
  ]);
  assert.equal(packet.status, 0, packet.text);
  assert.match(packet.stdout, /\[truncated: packet character budget reached\]/);
});

test("duet step minimax dry-run validates baton, estimates prompt, and spends no tokens", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_STEP_DRY_RUN_123";
  writeFile(dir, "goal.md", `Step goal ${secret}`);
  writeFile(dir, "handoff.md", `Step handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "3"]));
  fails(runBridge(dir, ["duet", "step", "--agent", "minimax", "--dry-run"]), /baton is held by codex/);
  fails(runBridge(dir, ["duet", "step", "--agent", "minimax", "--yes"]), /baton is held by codex/);
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const ledgerBefore = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  const stateBefore = fs.readFileSync(path.join(dir, "duet-state.json"), "utf8");
  const journalBefore = fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8");
  const dryRun = ok(runBridge(dir, ["duet", "step", "--agent", "minimax", "--dry-run"]));
  assert.equal(dryRun.event, "duet-step-dry-run");
  assert.equal(dryRun.agent, "minimax");
  assert.equal(dryRun.mode, "review-only");
  assert.equal(dryRun.tokenSpending, false);
  assert.equal(dryRun.wouldCallModel, true);
  assert.equal(dryRun.liveCallAllowed, true);
  assert.equal(dryRun.route.provider, "minimax");
  assert.equal(dryRun.warning, null);
  assert.deepEqual(dryRun.warnings, []);
  assert.equal(dryRun.packet.rawSha256, undefined);
  assert.equal(dryRun.packet.rawChars, undefined);
  assert.equal(typeof dryRun.packet.redactedSha256, "string");
  assert.equal(typeof dryRun.packet.redactedPreview, "string");
  assert.equal(dryRun.prompt.withinBudget, true);
  assert.equal(dryRun.prompt.sha256, undefined);
  assert.equal(dryRun.prompt.chars, undefined);
  assert.equal(dryRun.prompt.text, undefined);
  assert.doesNotMatch(JSON.stringify(dryRun), new RegExp(secret));
  assert.equal(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8"), ledgerBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-state.json"), "utf8"), stateBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8"), journalBefore);

  const raw = ok(runBridge(dir, ["duet", "step", "--agent", "minimax", "--dry-run", "--raw"]));
  assert.equal(typeof raw.packet.rawSha256, "string");
  assert.equal(typeof raw.packet.rawChars, "number");
  assert.equal(typeof raw.prompt.sha256, "string");
  assert.equal(typeof raw.prompt.chars, "number");
  assert.match(raw.prompt.text, new RegExp(secret));
});

test("duet step minimax dry-run rejects terminal and max-iteration states", (t) => {
  const emptyHandoffDir = sandbox(t);
  writeFile(emptyHandoffDir, "goal.md", "Initial minimax step goal");
  ok(runBridge(emptyHandoffDir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "3"]));
  const initialDryRun = ok(runBridge(emptyHandoffDir, ["duet", "step", "--agent", "minimax", "--dry-run"]));
  assert.equal(initialDryRun.warning, "missing_last_handoff");
  assert.deepEqual(initialDryRun.warnings, ["missing_last_handoff"]);

  const doneDir = sandbox(t);
  writeFile(doneDir, "goal.md", "Done step goal");
  writeFile(doneDir, "handoff.md", "Done step handoff");
  ok(runBridge(doneDir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "3"]));
  ok(runBridge(doneDir, ["duet", "pass", "--from", "minimax", "--status", "done", "--handoff", "handoff.md"]));
  fails(runBridge(doneDir, ["duet", "step", "--agent", "minimax", "--dry-run"]), /requires running status/);

  const limitDir = sandbox(t);
  writeFile(limitDir, "goal.md", "Limit step goal");
  ok(runBridge(limitDir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "1"]));
  const limitDryRun = ok(runBridge(limitDir, ["duet", "step", "--agent", "minimax", "--dry-run"]));
  assert.equal(limitDryRun.state.iteration, 1);
  assert.equal(limitDryRun.state.maxIterations, 1);
});

test("duet step codex dry-run validates baton and spends no tokens", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_CODEX_DRY_RUN_123";
  writeFile(dir, "goal.md", `Codex step goal ${secret}`);
  writeFile(dir, "handoff.md", `MiniMax handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "3"]));
  fails(runBridge(dir, ["duet", "step", "--agent", "codex", "--dry-run"]), /baton is held by minimax/);
  ok(runBridge(dir, ["duet", "pass", "--from", "minimax", "--to", "codex", "--handoff", "handoff.md"]));

  const ledgerBefore = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  const stateBefore = fs.readFileSync(path.join(dir, "duet-state.json"), "utf8");
  const journalBefore = fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8");
  const dryRun = ok(runBridge(dir, ["duet", "step", "--agent", "codex", "--dry-run"]));
  assert.equal(dryRun.event, "duet-step-dry-run");
  assert.equal(dryRun.agent, "codex");
  assert.equal(dryRun.mode, "exec");
  assert.equal(dryRun.codexMode, "exec");
  assert.equal(dryRun.tokenSpending, false);
  assert.equal(dryRun.wouldCallModel, true);
  assert.equal(dryRun.liveCallAllowed, true);
  assert.equal(dryRun.route.provider, "openai");
  assert.equal(dryRun.route.model, "codex-cli");
  assert.equal(typeof dryRun.route.cli, "string");
  assert.equal(dryRun.route.sandbox, "workspace-write");
  assert.equal(dryRun.route.workspaceMode, "exec");
  assert.equal(dryRun.route.skipGitRepoCheck, false);
  assert.equal(typeof dryRun.route.timeoutSec, "number");
  assert.equal(dryRun.packet.rawSha256, undefined);
  assert.equal(typeof dryRun.packet.redactedSha256, "string");
  assert.equal(dryRun.prompt.withinBudget, true);
  assert.doesNotMatch(JSON.stringify(dryRun), new RegExp(secret));
  assert.equal(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8"), ledgerBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-state.json"), "utf8"), stateBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8"), journalBefore);

  const isolated = ok(runBridge(dir, ["duet", "step", "--agent", "codex", "--dry-run", "--codex-mode", "isolated", "--raw"]));
  assert.equal(isolated.codexMode, "isolated");
  assert.equal(isolated.route.sandbox, "read-only");
  assert.equal(isolated.route.workspaceMode, "isolated");
  assert.equal(isolated.route.skipGitRepoCheck, true);
  assert.equal(isolated.route.hardSecurityBoundary, false);
  assert.match(isolated.warning, /not_hard_security_boundary/);
  assert.match(isolated.prompt.text, /isolated scratch mode/);
  assert.match(isolated.prompt.text, /not a hard security boundary/);

  fails(runBridge(dir, ["duet", "step", "--agent", "codex", "--dry-run", "--codex-mode", "bad"]), /--codex-mode must be isolated or exec/);
  fails(runBridge(dir, ["duet", "step", "--agent", "codex", "--dry-run", "--codex-mode"]), /--codex-mode requires isolated or exec/);
});

test("duet step minimax yes applies a fake review-only handoff without leaking by default", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_STEP_LIVE_123";
  writeFile(dir, "goal.md", `Live step goal ${secret}`);
  writeFile(dir, "handoff.md", `Codex handoff ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: running\n\nMiniMax reviewed the task and found ${secret}. Pass back to Codex.`,
  };
  const result = ok(runBridge(dir, ["duet", "step", "--agent", "minimax", "--yes"], { env }));
  assert.equal(result.event, "duet-step");
  assert.equal(result.applyStatus, "applied");
  assert.equal(result.tokenSpending, true);
  assert.equal(result.sessionID, "test-duet-step");
  assert.equal(result.status, "running");
  assert.equal(result.pendingPath, null);
  assert.equal(typeof result.appliedPath, "string");
  assert.equal(result.answer, undefined);
  assert.equal(result.packet.rawSha256, undefined);
  assert.equal(result.packet.rawChars, undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.baton, "codex");
  assert.equal(state.iteration, 3);
  assert.equal(state.status, "running");
  assert.match(state.lastHandoff, new RegExp(secret));
  assert.equal(fs.existsSync(result.appliedPath), true);
  assert.equal(fs.existsSync(result.pendingPath || ""), false);
  const ledger = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  assert.match(ledger, /"event":"duet-step"/);
});

test("duet step codex yes applies a fake exec handoff without leaking by default", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_CODEX_LIVE_123";
  writeFile(dir, "goal.md", `Codex live goal ${secret}`);

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: running\n\nCodex completed local work involving ${secret}. Pass back to MiniMax.`,
  };
  const result = ok(runBridge(dir, ["duet", "step", "--agent", "codex", "--yes"], { env }));
  assert.equal(result.event, "duet-step");
  assert.equal(result.agent, "codex");
  assert.equal(result.mode, "exec");
  assert.equal(result.codexMode, "exec");
  assert.equal(result.applyStatus, "applied");
  assert.equal(result.tokenSpending, true);
  assert.equal(result.provider, "openai");
  assert.equal(result.role, "codex");
  assert.equal(result.model, "codex-cli:test");
  assert.equal(result.status, "running");
  assert.equal(result.pendingPath, null);
  assert.equal(typeof result.appliedPath, "string");
  assert.equal(result.answer, undefined);
  assert.equal(result.usage.input_tokens > 0, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.baton, "minimax");
  assert.equal(state.iteration, 2);
  assert.equal(state.status, "running");
  assert.match(state.lastHandoff, new RegExp(secret));
  assert.equal(fs.existsSync(result.appliedPath), true);
  const ledger = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  assert.match(ledger, /"agent":"codex"/);
});

test("duet step codex isolated yes applies a fake handoff and reports codex mode", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Codex isolated live goal");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: running\n\nCodex isolated mode reply.",
  };
  const result = ok(runBridge(dir, ["duet", "step", "--agent", "codex", "--yes", "--codex-mode", "isolated"], { env }));
  assert.equal(result.event, "duet-step");
  assert.equal(result.agent, "codex");
  assert.equal(result.mode, "exec");
  assert.equal(result.codexMode, "isolated");
  assert.equal(result.applyStatus, "applied");
  assert.equal(result.model, "codex-cli:test");

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.baton, "minimax");
  assert.equal(state.status, "running");
});

test("duet step codex yes replaces an empty fake handoff with a fallback", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Codex empty handoff goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "",
  };
  const result = ok(runBridge(dir, ["duet", "step", "--agent", "codex", "--yes"], { env }));
  assert.equal(result.applyStatus, "applied");
  assert.equal(result.status, "running");

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.baton, "minimax");
  assert.match(state.lastHandoff, /Codex returned an empty handoff/);
});

test("duet step minimax yes keeps pending handoff and state on apply failure", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Apply failure goal");
  writeFile(dir, "handoff.md", "Codex handoff");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));
  const stateBefore = fs.readFileSync(path.join(dir, "duet-state.json"), "utf8");
  const journalBefore = fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8");

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: running\n\n${"x".repeat(21000)}`,
  };
  const failed = runBridge(dir, ["duet", "step", "--agent", "minimax", "--yes"], { env });
  assert.notEqual(failed.status, 0, failed.text);
  const body = jsonOutput(failed);
  assert.equal(body.event, "duet-step");
  assert.equal(body.applyStatus, "apply_failed");
  assert.match(body.error, /--handoff file is too large/);
  assert.equal(typeof body.pendingPath, "string");
  assert.equal(fs.existsSync(body.pendingPath), true);
  assert.equal(fs.readFileSync(path.join(dir, "duet-state.json"), "utf8"), stateBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8"), journalBefore);
});

test("duet step minimax yes validates baton before fake model call", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Wrong baton live goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));
  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: running\n\nShould not be used.",
  };
  fails(runBridge(dir, ["duet", "step", "--agent", "minimax", "--yes"], { env }), /baton is held by codex/);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".duet-step-minimax-")), false);
});

test("duet step fake model reply requires explicit test gate", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Fake gate goal");
  writeFile(dir, "handoff.md", "Fake gate handoff");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));
  const env = {
    ...process.env,
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: running\n\nThis must not be applied without the test gate.",
  };
  const result = runBridge(dir, ["duet", "step", "--agent", "minimax", "--yes", "--port", "1"], { env });
  assert.notEqual(result.status, 0, result.text);
  assert.doesNotMatch(result.text, /test-duet-step/);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".duet-step-minimax-")), false);
});

test("duet loop dry-run previews next agent step and does not mutate relay files", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_LOOP_DRY_RUN_123";
  writeFile(dir, "goal.md", `Loop goal ${secret}`);
  writeFile(dir, "handoff.md", `MiniMax handoff ${secret}`);
  writeFile(dir, "verify.mjs", "console.log('ok');");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "minimax", "--max-iterations", "5"]));
  ok(runBridge(dir, ["duet", "pass", "--from", "minimax", "--to", "codex", "--handoff", "handoff.md"]));
  const ledgerBefore = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  const stateBefore = fs.readFileSync(path.join(dir, "duet-state.json"), "utf8");
  const journalBefore = fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8");

  const dryRun = ok(runBridge(dir, [
    "duet",
    "loop",
    "--dry-run",
    "--max-rounds",
    "4",
    "--max-codex-steps",
    "2",
    "--max-minimax-steps",
    "2",
    "--max-tokens",
    "50000",
    "--verifier",
    "verify.mjs",
    "--",
    "--fast",
  ]));
  assert.equal(dryRun.event, "duet-loop-dry-run");
  assert.equal(dryRun.tokenSpending, false);
  assert.equal(dryRun.wouldRunLoop, true);
  assert.equal(dryRun.wouldCallAgent, true);
  assert.deepEqual(dryRun.stopReasons, []);
  assert.equal(dryRun.nextStep.agent, "codex");
  assert.equal(dryRun.nextStep.mode, "exec");
  assert.equal(dryRun.nextStep.codexMode, "exec");
  assert.equal(dryRun.nextStep.tokenSpending, true);
  assert.equal(dryRun.nextStep.withinTokenBudget, true);
  assert.equal(typeof dryRun.nextStep.estimatedInputTokens, "number");
  assert.equal(dryRun.nextStep.route.cli, "codex.cmd");
  assert.equal(dryRun.nextStep.route.sandbox, "workspace-write");
  assert.equal(dryRun.nextStep.route.workspaceMode, "exec");
  assert.equal(dryRun.nextStep.route.skipGitRepoCheck, false);
  assert.equal(dryRun.verifier.path.path, path.join(dir, "verify.mjs"));
  assert.equal(dryRun.verifier.path.basename, "verify.mjs");
  assert.deepEqual(dryRun.verifier.args, ["--fast"]);
  assert.equal(dryRun.limits.maxRounds, 4);
  assert.equal(dryRun.limits.profile, "default");
  assert.equal(dryRun.limits.codexMode, "exec");
  assert.deepEqual(dryRun.requirements.requiredAgents, []);
  assert.deepEqual(dryRun.requirements.satisfiedAgents, []);
  assert.deepEqual(dryRun.requirements.missingAgents, []);
  assert.doesNotMatch(JSON.stringify(dryRun), new RegExp(secret));
  assert.equal(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8"), ledgerBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-state.json"), "utf8"), stateBefore);
  assert.equal(fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8"), journalBefore);
});

test("duet loop dry-run reports terminal and budget stops without agent preview", (t) => {
  const doneDir = sandbox(t);
  writeFile(doneDir, "goal.md", "Loop done goal");
  writeFile(doneDir, "handoff.md", "Loop done handoff");
  ok(runBridge(doneDir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));
  ok(runBridge(doneDir, ["duet", "pass", "--from", "codex", "--status", "done", "--handoff", "handoff.md"]));
  const terminal = ok(runBridge(doneDir, ["duet", "loop", "--dry-run"]));
  assert.equal(terminal.wouldRunLoop, false);
  assert.deepEqual(terminal.stopReasons, ["terminal_status:done"]);
  assert.equal(terminal.nextStep, null);
  const terminalWithLowRoundLimit = ok(runBridge(doneDir, ["duet", "loop", "--dry-run", "--max-rounds", "1"]));
  assert.deepEqual(terminalWithLowRoundLimit.stopReasons, ["terminal_status:done"]);

  const budgetDir = sandbox(t);
  writeFile(budgetDir, "goal.md", "Loop budget goal");
  ok(runBridge(budgetDir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));
  const budget = ok(runBridge(budgetDir, ["duet", "loop", "--dry-run", "--max-tokens", "1"]));
  assert.equal(budget.wouldRunLoop, false);
  assert.match(budget.stopReasons.join(","), /token_budget:/);
  assert.equal(budget.nextStep.agent, "codex");
  assert.equal(budget.nextStep.withinTokenBudget, false);
});

test("duet loop smoke profile applies compact defaults and allows overrides", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Loop smoke profile goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const smoke = ok(runBridge(dir, ["duet", "loop", "--dry-run", "--profile", "smoke"]));
  assert.equal(smoke.event, "duet-loop-dry-run");
  assert.equal(smoke.limits.profile, "smoke");
  assert.equal(smoke.limits.maxRounds, 2);
  assert.equal(smoke.limits.maxCodexSteps, 1);
  assert.equal(smoke.limits.maxMiniMaxSteps, 1);
  assert.equal(smoke.limits.maxTokens, 60000);
  assert.equal(smoke.limits.maxPacketChars, 20000);
  assert.equal(smoke.limits.codexMode, "isolated");
  assert.equal(smoke.nextStep.codexMode, "isolated");
  assert.match(smoke.nextStep.command, /--codex-mode isolated/);
  assert.equal(smoke.nextStep.route.sandbox, "read-only");
  assert.equal(smoke.nextStep.route.workspaceMode, "isolated");
  assert.equal(smoke.nextStep.route.skipGitRepoCheck, true);
  assert.equal(smoke.nextStep.route.hardSecurityBoundary, false);

  const override = ok(runBridge(dir, ["duet", "loop", "--dry-run", "--profile", "smoke", "--max-rounds", "4", "--codex-mode", "exec"]));
  assert.equal(override.limits.profile, "smoke");
  assert.equal(override.limits.maxRounds, 4);
  assert.equal(override.limits.codexMode, "exec");
  assert.equal(override.nextStep.route.sandbox, "workspace-write");

  fails(runBridge(dir, ["duet", "loop", "--dry-run", "--profile", "huge"]), /--profile must be smoke or default/);
  fails(runBridge(dir, ["duet", "loop", "--dry-run", "--codex-mode", "bad"]), /--codex-mode must be isolated or exec/);
  fails(runBridge(dir, ["duet", "loop", "--dry-run", "--codex-mode"]), /--codex-mode requires isolated or exec/);
});

test("duet loop dry-run validates required agents", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Loop required agents dry-run goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const dryRun = ok(runBridge(dir, ["duet", "loop", "--dry-run", "--require-agents", "codex,minimax"]));
  assert.deepEqual(dryRun.requirements.requiredAgents, ["codex", "minimax"]);
  assert.deepEqual(dryRun.requirements.satisfiedAgents, []);
  assert.deepEqual(dryRun.requirements.missingAgents, ["codex", "minimax"]);

  fails(
    runBridge(dir, ["duet", "loop", "--dry-run", "--require-agents", "codex,codex"]),
    /must not repeat agents/,
  );
  fails(
    runBridge(dir, ["duet", "loop", "--dry-run", "--require-agents", "codex,other"]),
    /--require-agents must be one of: codex, minimax/,
  );
});

test("duet loop rejects unknown guardrail flags and respects verifier separator", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Unknown flag goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));

  fails(
    runBridge(dir, ["duet", "loop", "--dry-run", "--watch-readonly", "somewhere"]),
    /duet loop does not support --watch-readonly/,
  );
  fails(
    runBridge(dir, ["duet", "start", "--goal", "goal.md", "--profile", "review", "--force"]),
    /duet start does not support --profile/,
  );
  writeFile(dir, "handoff.md", "Unknown pass flag handoff");
  fails(
    runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md", "--dry-run"]),
    /duet pass does not support --dry-run/,
  );
  fails(
    runBridge(dir, ["duet", "note", "--agent", "codex", "--note", "handoff.md", "--dry-run"]),
    /duet note does not support --dry-run/,
  );

  writeFile(dir, "verify.mjs", "process.exit(0);");
  const dryRun = ok(runBridge(dir, ["duet", "loop", "--dry-run", "--verifier", "verify.mjs", "--", "--yes"]));
  assert.equal(dryRun.event, "duet-loop-dry-run");
  assert.deepEqual(dryRun.verifier.args, ["--yes"]);
});

test("duet loop yes applies fake steps until done without leaking by default", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_LOOP_DONE_123";
  writeFile(dir, "goal.md", `Loop live goal ${secret}`);
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: done\n\nCodex loop completed ${secret}.`,
  };
  const result = ok(runBridge(dir, ["duet", "loop", "--yes", "--max-rounds", "3"], { env }));
  assert.equal(result.event, "duet-loop");
  assert.equal(result.mode, "live");
  assert.equal(result.tokenSpending, true);
  assert.equal(result.status, "done");
  assert.deepEqual(result.stopReasons, ["terminal_status:done"]);
  assert.equal(result.counts.rounds, 1);
  assert.equal(result.counts.codexSteps, 1);
  assert.equal(result.counts.minimaxSteps, 0);
  assert.equal(result.steps[0].agent, "codex");
  assert.equal(result.steps[0].applyStatus, "applied");
  assert.equal(result.usage.estimatedInputTokens > 0, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "done");
  assert.equal(state.baton, null);
  assert.match(state.lastHandoff, new RegExp(secret));
});

test("duet loop yes suppresses premature done until required agents contribute", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_LOOP_REQUIRE_AGENTS_123";
  writeFile(dir, "goal.md", `Loop required agents goal ${secret}`);
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: done\n\nPremature completion ${secret}.`,
  };
  const result = ok(runBridge(dir, [
    "duet",
    "loop",
    "--yes",
    "--max-rounds",
    "3",
    "--require-agents",
    "codex,minimax",
  ], { env }));
  assert.equal(result.event, "duet-loop");
  assert.equal(result.status, "done");
  assert.deepEqual(result.stopReasons, ["terminal_status:done"]);
  assert.equal(result.counts.codexSteps, 1);
  assert.equal(result.counts.minimaxSteps, 1);
  assert.equal(result.steps[0].agent, "codex");
  assert.equal(result.steps[0].codexMode, "exec");
  assert.equal(result.steps[0].status, "running");
  assert.equal(result.steps[0].modelStatus, "done");
  assert.equal(result.steps[0].suppressedTerminalStatus, "done");
  assert.match(result.steps[0].suppressionReason, /required_agents_missing:minimax/);
  assert.equal(result.steps[1].agent, "minimax");
  assert.equal(result.steps[1].status, "done");
  assert.equal(result.steps[1].modelStatus, "done");
  assert.deepEqual(result.requirements.requiredAgents, ["codex", "minimax"]);
  assert.deepEqual(result.requirements.satisfiedAgents, ["codex", "minimax"]);
  assert.deepEqual(result.requirements.missingAgents, []);
  assert.equal(result.suppressedTerminalStatuses.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "done");
  assert.equal(state.baton, null);

  const report = ok(runBridge(dir, ["duet", "report"]));
  assert.deepEqual(report.lastLoop.requirements.requiredAgents, ["codex", "minimax"]);
  assert.equal(report.lastLoop.suppressedTerminalStatuses.length, 1);
  assert.equal(report.lastLoop.steps[0].codexMode, "exec");
  assert.equal(report.lastLoop.steps[0].suppressedTerminalStatus, "done");

  const markdownReport = runBridge(dir, ["duet", "report", "--format", "markdown"]);
  assert.equal(markdownReport.status, 0, markdownReport.text);
  assert.match(markdownReport.stdout, /codexMode=exec/);
});

test("duet report preserves loop profile and codex mode in continue commands", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Report continue command goal");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: running\n\nStill reviewing.",
  };
  ok(runBridge(dir, ["duet", "loop", "--yes", "--profile", "smoke", "--require-agents", "codex,minimax"], { env }));

  const report = ok(runBridge(dir, ["duet", "report"]));
  assert.match(report.next.continue[0], /--profile smoke/);
  assert.match(report.next.continue[0], /--codex-mode isolated/);
  assert.match(report.next.continue[1], /--profile smoke/);
  assert.match(report.next.continue[1], /--codex-mode isolated/);

  const markdownReport = runBridge(dir, ["duet", "report", "--format", "markdown"]);
  assert.equal(markdownReport.status, 0, markdownReport.text);
  assert.match(markdownReport.stdout, /duet loop --dry-run --profile smoke --codex-mode isolated/);
});

test("duet loop yes does not suppress human escalation for required agents", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Loop human escalation required agents goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: human_escalation\n\nNeed human decision.",
  };
  const result = ok(runBridge(dir, [
    "duet",
    "loop",
    "--yes",
    "--max-rounds",
    "3",
    "--require-agents",
    "codex,minimax",
  ], { env }));
  assert.equal(result.status, "human_escalation");
  assert.deepEqual(result.stopReasons, ["terminal_status:human_escalation"]);
  assert.equal(result.counts.codexSteps, 1);
  assert.equal(result.counts.minimaxSteps, 0);
  assert.deepEqual(result.requirements.satisfiedAgents, ["codex"]);
  assert.deepEqual(result.requirements.missingAgents, ["minimax"]);
  assert.deepEqual(result.suppressedTerminalStatuses, []);
  assert.equal(result.steps[0].modelStatus, "human_escalation");
  assert.equal(result.steps[0].suppressedTerminalStatus, null);
});

test("duet loop yes stops when actual step usage exceeds token budget", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Loop actual token budget goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: running\n\n${"x".repeat(18000)}`,
  };
  const result = ok(runBridge(dir, ["duet", "loop", "--yes", "--max-rounds", "3", "--max-tokens", "3000"], { env }));
  assert.equal(result.event, "duet-loop");
  assert.equal(result.status, "running");
  assert.match(result.stopReasons.join(","), /actual_token_budget:/);
  assert.equal(result.budget.actualExceeded, true);
  assert.equal(result.budget.violation, "actual");
  assert.equal(result.budget.terminalStatus, "running");
  assert.equal(result.counts.rounds, 1);
  assert.equal(result.counts.codexSteps, 1);
  assert.equal(result.counts.minimaxSteps, 0);
  assert.equal(result.steps[0].applyStatus, "applied");
  assert.equal(result.usage.inputTokens + result.usage.outputTokens > result.limits.maxTokens, true);

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "running");
  assert.equal(state.baton, "minimax");
});

test("duet loop yes stops repeated fake handoffs before max iterations", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Loop repeated handoff goal");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "8"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: running\n\nSame handoff every time.",
  };
  const result = ok(runBridge(dir, ["duet", "loop", "--yes", "--max-rounds", "5", "--max-codex-steps", "3", "--max-minimax-steps", "3"], { env }));
  assert.equal(result.event, "duet-loop");
  assert.equal(result.status, "running");
  assert.deepEqual(result.stopReasons, ["repeated_handoff_hash"]);
  assert.equal(result.counts.rounds, 2);
  assert.equal(result.counts.codexSteps, 1);
  assert.equal(result.counts.minimaxSteps, 1);

  const state = readJson(dir, "duet-state.json");
  assert.equal(state.status, "running");
  assert.equal(state.baton, "codex");
});

test("duet loop yes stops on verifier failure after a running step", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Loop verifier failure goal");
  writeFile(dir, "verify.mjs", "console.error('not yet'); process.exit(2);");
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "8"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: "Status: running\n\nContinue after verifier.",
  };
  const result = ok(runBridge(dir, ["duet", "loop", "--yes", "--max-rounds", "5", "--verifier", "verify.mjs"], { env }));
  assert.equal(result.event, "duet-loop");
  assert.deepEqual(result.stopReasons, ["verifier_fail"]);
  assert.equal(result.counts.rounds, 1);
  assert.equal(result.verifierRuns.length, 1);
  assert.equal(result.verifierRuns[0].status, "fail");
  assert.equal(result.verifierRuns[0].exitCode, 2);

  const journal = fs.readFileSync(path.join(dir, "duet-journal.md"), "utf8");
  assert.match(journal, /Verify - loop/);
  assert.match(journal, /status=fail/);
});

test("duet report summarizes the latest loop without leaking relay text", (t) => {
  const dir = sandbox(t);
  const secret = "SECRET_DUET_REPORT_123";
  writeFile(dir, "goal.md", `Loop report goal ${secret}`);
  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--baton", "codex", "--max-iterations", "5"]));

  const env = {
    ...process.env,
    MAVIS_BRIDGE_ENABLE_TEST_MODEL_REPLY: "1",
    MAVIS_BRIDGE_TEST_MODEL_REPLY: `Status: done\n\nCodex loop report completed ${secret}.`,
  };
  ok(runBridge(dir, ["duet", "loop", "--yes", "--max-rounds", "3"], { env }));

  const report = ok(runBridge(dir, ["duet", "report"]));
  assert.equal(report.event, "duet-report");
  assert.equal(report.redacted, true);
  assert.equal(report.state.status, "done");
  assert.equal(report.lastLoop.found, true);
  assert.deepEqual(report.lastLoop.stopReasons, ["terminal_status:done"]);
  assert.equal(report.lastLoop.terminalStatus, "done");
  assert.equal(report.lastLoop.budget.actualExceeded, false);
  assert.equal(report.lastLoop.counts.codexSteps, 1);
  assert.equal(report.lastLoop.steps[0].agent, "codex");
  assert.equal(typeof report.transcript.journal.sha256, "string");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));

  const markdown = ok(runBridge(dir, ["duet", "report", "--format", "markdown", "--out", "duet-report.local.md"]));
  assert.equal(markdown.event, "duet-report");
  assert.equal(markdown.format, "markdown");
  const text = fs.readFileSync(path.join(dir, "duet-report.local.md"), "utf8");
  assert.match(text, /# Duet Run Report/);
  assert.match(text, /terminal_status:done/);
  assert.match(text, /Budget:/);
  assert.doesNotMatch(text, new RegExp(secret));
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
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-transcript-outside-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
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

  fails(
    runBridge(dir, ["duet", "transcript", "export", "--out", path.join(other, "transcript.md")]),
    /--out path escapes bridge root/,
  );

  try {
    fs.writeFileSync(path.join(other, "outside.md"), "outside", "utf8");
    fs.symlinkSync(path.join(other, "outside.md"), path.join(dir, "transcript-link.local.md"), "file");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.message}`);
    return;
  }
  fails(
    runBridge(dir, ["duet", "transcript", "export", "--raw", "--out", "transcript-link.local.md"]),
    /--out must not target a symlink/,
  );
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

test("duet pass validates handoff path boundaries and file type", (t) => {
  const dir = sandbox(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-handoff-outside-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeFile(dir, "goal.md", "Path boundary goal");
  writeFile(dir, "handoff.md", "Valid handoff");
  fs.mkdirSync(path.join(dir, "handoff-dir"));
  writeFile(other, "outside.md", "Outside handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));

  fails(
    runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", path.join(other, "outside.md")]),
    /--handoff path escapes bridge root/,
  );
  fails(
    runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff-dir"]),
    /--handoff is not a regular file/,
  );

  ok(runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]));
  assert.equal(readJson(dir, "duet-state.json").baton, "minimax");
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
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "too-large.md"]), /--handoff file is too large/);

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

test("duet lock blocks overlapping mutating commands and refuses stale locks", (t) => {
  const dir = sandbox(t);
  writeFile(dir, "goal.md", "Lock goal");
  writeFile(dir, "handoff.md", "Lock handoff");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md", "--max-iterations", "3"]));
  const lockPath = path.join(dir, "duet.lock");
  fs.writeFileSync(lockPath, "held", "utf8");
  fails(runBridge(dir, ["duet", "pass", "--from", "codex", "--handoff", "handoff.md"]), /duet lock is held/);

  const stale = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockPath, stale, stale);
  fails(
    runBridge(dir, ["duet", "pass", "--from", "codex", "--to", "minimax", "--handoff", "handoff.md"]),
    /refusing automatic removal/,
  );
  assert.equal(readJson(dir, "duet-state.json").baton, "codex");
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
  git(dir, ["add", ...bridgeRuntimeGitPaths(dir), "tracked.txt"]);
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

test("ask dry-run excludes untracked secret-looking files", (t) => {
  const dir = sandbox(t);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Bridge Test"]);
  writeFile(dir, "tracked.txt", "before\n");
  git(dir, ["add", ...bridgeRuntimeGitPaths(dir), "tracked.txt"]);
  git(dir, ["commit", "-m", "seed"]);

  writeFile(dir, "task.md", "Review secret exclusions.");
  writeFile(dir, ".npmrc", "NPMRC_SECRET_SHOULD_NOT_APPEAR\n");
  writeFile(dir, "secrets.json", "JSON_SECRET_SHOULD_NOT_APPEAR\n");
  writeFile(dir, "id_ed25519", "KEY_SECRET_SHOULD_NOT_APPEAR\n");
  writeFile(dir, "visible.txt", "VISIBLE_UNTRACKED_CONTEXT\n");

  const dryRun = ok(runBridge(dir, ["ask", "--dry-run", "--task", "task.md", "--raw"]));
  assert.match(dryRun.sourceContext.text, /VISIBLE_UNTRACKED_CONTEXT/);
  assert.match(dryRun.sourceContext.text, /\.npmrc/);
  assert.match(dryRun.sourceContext.text, /skipped: excluded/);
  assert.doesNotMatch(dryRun.sourceContext.text, /NPMRC_SECRET_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(dryRun.sourceContext.text, /JSON_SECRET_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(dryRun.sourceContext.text, /KEY_SECRET_SHOULD_NOT_APPEAR/);
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
  git(dir, ["add", ...bridgeRuntimeGitPaths(dir), "task.md", "src/alpha.txt", "src/beta.txt"]);
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

test("ask include source context block matches the expected golden format", (t) => {
  const dir = sandbox(t);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Bridge Test"]);
  fs.mkdirSync(path.join(dir, "src"));
  writeFile(dir, "task.md", "Review explicit includes.");
  writeFile(dir, "src/alpha.txt", "EXPLICIT_INCLUDE_ALPHA\n");
  writeFile(dir, "src/beta.txt", "EXPLICIT_INCLUDE_BETA\n");
  git(dir, ["add", ...bridgeRuntimeGitPaths(dir), "task.md", "src/alpha.txt", "src/beta.txt"]);
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

  // Golden gate: a clean worktree with explicit includes is deterministic
  // (untrackedCount: 0), so pin the whole block to catch any wrapper or
  // ordering regression in the moved source-context snippet/sort logic.
  assert.equal(dryRun.sourceContext.untrackedCount, 0);
  const expected = [
    '<source_context mode="auto" chars="24000" truncated="false">',
    "MiniMax source visibility context.",
    "The reviewer may not have direct access to this local worktree; use this bounded context as the source of truth for uncommitted changes.",
    "",
    "",
    "## explicit include text file snippets",
    "",
    "### src/alpha.txt",
    "",
    "```",
    "EXPLICIT_INCLUDE_ALPHA",
    "",
    "```",
    "",
    "### src/beta.txt",
    "",
    "```",
    "EXPLICIT_INCLUDE_BETA",
    "",
    "```",
    "</source_context>",
  ].join("\n");
  assert.equal(dryRun.sourceContext.text, expected);
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
  fails(
    runBridge(dir, ["ask", "--dry-run", "--task", path.join(other, "outside.txt")]),
    /--task path escapes bridge root/,
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

test("sandbox runtime files stay in bridge root and never under lib", (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFile(dir, "goal.md", "Sandbox runtime root goal");

  ok(runBridge(dir, ["duet", "init", "--goal", "goal.md"]));
  for (const name of ["duet-state.json", "duet-journal.md", "ledger.jsonl"]) {
    assert.equal(fs.existsSync(path.join(dir, name)), true, `${name} should be written to sandbox root`);
    assert.equal(fs.existsSync(path.join(dir, "lib", name)), false, `${name} must not be written under lib`);
  }
  assert.equal(fs.existsSync(path.join(dir, "lib", "config.json")), false, "config.json must not be written under lib");
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

test("token-stats can invoke a configured mavis.cmd path containing spaces", (t) => {
  const dir = sandboxWithSpace(t);
  const binDir = path.join(dir, "fake bin");
  fs.mkdirSync(binDir);
  const mavisCmd = path.join(binDir, "mavis test.cmd");
  fs.writeFileSync(
    mavisCmd,
    "@echo off\r\necho {\"summary\":{\"turns\":1,\"inputTokens\":42,\"outputTokens\":7},\"rows\":[{\"model\":\"minimax/MiniMax-M3\",\"inputTokens\":42,\"outputTokens\":7}]}\r\n",
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ mavisCli: mavisCmd }), "utf8");

  const stats = ok(runBridge(dir, ["token-stats", "--session", "mvs_good"]));
  assert.equal(stats.usage.skipped, false);
  assert.equal(stats.usage.summary.inputTokens, 42);
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
    ".codex-isolated-2026-06-28T00-00-00-000Z-abc123.local/",
    "live-smoke-tetris-zero-20260627/index.html",
    ".env.local",
    ".envrc",
    "docs/AUDIT_FINDINGS.md",
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
    "docs/LIVE_RUNBOOK.md",
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

  for (const relative of ["skills/bridge/SKILL.md", "skills/codex-bridge/SKILL.md", "prompts/bridge.md"]) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /--codex-mode isolated/, `${relative} should document isolated Codex mode`);
    assert.match(text, /not\s+a\s+hard\s+security\s+boundary|not\s+hard\s+security/, `${relative} should avoid overstating isolated mode`);
  }

  const runtimeFiles = fs.readFileSync(path.join(repoRoot, "docs/RUNTIME_FILES.md"), "utf8");
  assert.match(runtimeFiles, /\.codex-isolated-\*\.local\//, "runtime docs should list isolated Codex scratch directories");
  assert.match(runtimeFiles, /disposable/, "runtime docs should explain isolated scratch cleanup");
  assert.match(runtimeFiles, /active runtime root/, "runtime docs should clarify clone-local runtime scope");

  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /npm install -g.*not supported/s, "README should clarify clone-only install");
  assert.match(readme, /Exec mode can modify bridge\s+repository files and local runtime files/, "README should disclose exec-mode write access");
  const commandsDoc = fs.readFileSync(path.join(repoRoot, "docs/COMMANDS.md"), "utf8");
  assert.match(commandsDoc, /Exec mode can modify bridge repository\s+files and local runtime files/, "commands docs should disclose exec-mode write access");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.private, true, "package should not be publishable to npm by accident");

  const runbook = fs.readFileSync(path.join(repoRoot, "docs/LIVE_RUNBOOK.md"), "utf8");
  assert.match(runbook, /duet start --goal/, "live runbook should start with duet start");
  assert.match(runbook, /duet loop --dry-run/, "live runbook should require dry-run preflight");
  assert.match(runbook, /duet loop --yes/, "live runbook should document the live loop");
  assert.match(runbook, /duet report/, "live runbook should finish with report");
  assert.match(runbook, /can spend Codex\/OpenAI and MiniMax tokens/, "live runbook should warn about token spending");
});

test("install scripts reject unknown options before writing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bridge-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const script of ["install-mavis-skill.mjs", "install-codex-skill.mjs", "install-codex-slash.mjs"]) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", script), "--dryrun", "--codex-home", dir, "--mavis-root", dir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${script}\n${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /unknown option: --dryrun/);
  }
  assert.equal(fs.existsSync(path.join(dir, "skills")), false);
  assert.equal(fs.existsSync(path.join(dir, "prompts")), false);
});
