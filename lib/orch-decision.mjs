const ACTIONS = ["run", "done", "escalate"];

function extractJsonBlock(text) {
  const input = String(text || "");
  const fenced = input.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidate = fenced ? fenced[1] : (input.match(/\{[\s\S]*\}/) || [])[0];
  if (!candidate) throw new Error("no decision JSON in orchestrator output");
  try {
    return JSON.parse(candidate);
  } catch (_) {
    throw new Error("no decision JSON in orchestrator output: not valid JSON");
  }
}

function optionalString(out, key, value) {
  if (value !== undefined) out[key] = String(value);
}

export function parseOrchestratorDecision(text, workerIds) {
  const workers = Array.isArray(workerIds) ? workerIds : [];
  const raw = extractJsonBlock(text);
  const action = String(raw.action || "").toLowerCase();
  if (!ACTIONS.includes(action)) throw new Error(`invalid action: ${raw.action}`);

  if (action === "run") {
    if (!workers.includes(raw.worker)) throw new Error(`unknown worker: ${raw.worker}`);
    if (!raw.subtask || !String(raw.subtask).trim()) throw new Error("subtask is required for run");
    const out = { action, worker: raw.worker, subtask: String(raw.subtask) };
    optionalString(out, "note", raw.note);
    return out;
  }

  const out = { action };
  if (action === "done") out.summary = String(raw.summary || "");
  if (action === "escalate") out.reason = String(raw.reason || "");
  optionalString(out, "note", raw.note);
  return out;
}
