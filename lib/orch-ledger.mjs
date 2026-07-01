import fs from "node:fs";
import path from "node:path";
import { stableStringify } from "./json.mjs";

export function readOrchLedger(filePath) {
  if (!fs.existsSync(filePath)) return { events: [], dropped: 0 };
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) return { events: [], dropped: 0 };
  const events = [];
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      dropped += 1;
    }
  }
  return { events, dropped };
}

export function appendOrchEvent(filePath, event, now = () => new Date()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const seq = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim()).length
    : 0;
  const written = {
    seq,
    ts: now().toISOString(),
    ...event,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(written)}\n`, "utf8");
  return written;
}

export function projectOrchState(events) {
  const list = Array.isArray(events) ? events : [];
  const state = {
    status: "none",
    step: 0,
    spent: { tokens: 0 },
    lastDecision: null,
  };
  for (const event of list) {
    if (Number.isFinite(Number(event.step))) state.step = Math.max(state.step, Number(event.step));
    const usage = event.usage || {};
    const input = usage.inputTokens ?? usage.input_tokens ?? 0;
    const output = usage.outputTokens ?? usage.output_tokens ?? 0;
    state.spent.tokens += Math.max(0, Number(input) || 0) + Math.max(0, Number(output) || 0);
    if (event.kind === "init") state.status = "running";
    if (event.kind === "decision") state.lastDecision = event.decision || null;
    if (event.kind === "final") state.status = event.status || "done";
  }
  return state;
}

export function ambiguousTail(events) {
  const list = Array.isArray(events) ? events : [];
  const last = list[list.length - 1];
  if (!last || last.kind !== "worker-started") return null;
  return {
    worker: last.worker,
    subtask: last.subtask,
    step: last.step,
  };
}

export function writeOrchState(filePath, state) {
  fs.writeFileSync(filePath, stableStringify(state), "utf8");
}
