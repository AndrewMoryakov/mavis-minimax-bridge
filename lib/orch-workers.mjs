import { buildWorkerSummary } from "./worker-summary.mjs";

function parseSelfReport(text) {
  const input = String(text || "");
  const candidates = [
    ...[...input.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi)].map((match) => match[1]),
    ...[...input.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]),
  ];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {
      // Keep scanning older candidates; worker prompts may include JSON examples.
    }
  }
  return null;
}

function workerPrompt({ workerId, subtask, goal, priorSummaries }) {
  return [
    `# Worker: ${workerId}`,
    "",
    "# Original Goal",
    String(goal || ""),
    "",
    "# Scoped Subtask",
    String(subtask || ""),
    "",
    "# Prior Worker Summaries",
    JSON.stringify(Array.isArray(priorSummaries) ? priorSummaries : []),
    "",
    "Work only on the scoped subtask. End with a compact JSON self-report like:",
    '{"did":"short summary of what you did"}',
  ].join("\n");
}

export function makeWorkerRunner({ participants, runWorker, writeRaw, maxSummaryChars = 2000, goal }) {
  const registry = new Map((participants || []).map((participant) => [participant.id, participant]));
  const priorSummaries = [];

  return {
    async run(workerId, subtask, { step } = {}) {
      const participant = registry.get(workerId);
      if (!participant) throw new Error(`unknown orchestrator worker: ${workerId}`);
      const prompt = workerPrompt({ workerId, subtask, goal, priorSummaries });
      try {
        const result = await runWorker(participant, prompt, { step, subtask });
        const rawOutput = String(result.rawOutput || "");
        const rawRef = writeRaw ? writeRaw(`${step}-${workerId}.raw.txt`, rawOutput) : null;
        const summary = buildWorkerSummary({
          worker: workerId,
          step,
          status: result.status || "ok",
          rawOutput,
          selfReport: result.selfReport || parseSelfReport(rawOutput),
          artifacts: result.artifacts || [],
          rawRef,
          maxSummaryChars,
        });
        priorSummaries.push({ worker: workerId, subtask, summary });
        return { summary, usage: result.usage || {} };
      } catch (error) {
        const rawOutput = String(error?.message || error);
        const rawRef = writeRaw ? writeRaw(`${step}-${workerId}.error.txt`, rawOutput) : null;
        const summary = buildWorkerSummary({
          worker: workerId,
          step,
          status: "error",
          rawOutput,
          selfReport: null,
          artifacts: [],
          rawRef,
          maxSummaryChars,
        });
        priorSummaries.push({ worker: workerId, subtask, summary });
        return { summary, usage: {} };
      }
    },
  };
}
