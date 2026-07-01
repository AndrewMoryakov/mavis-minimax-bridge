import { parseOrchestratorDecision } from "./orch-decision.mjs";

function usageTokenCount(usage = {}) {
  const input = usage.inputTokens ?? usage.input_tokens ?? 0;
  const output = usage.outputTokens ?? usage.output_tokens ?? 0;
  return Math.max(0, Number(input) || 0) + Math.max(0, Number(output) || 0);
}

export function makeOrchestrator({ workerIds, askOrchestrator, systemPrompt, goal }) {
  const workers = Array.isArray(workerIds) ? workerIds : [];
  async function ask(body) {
    return await askOrchestrator([systemPrompt, body].filter(Boolean).join("\n\n"));
  }

  return {
    async decide(lastSummary) {
      const input = [
        "# Original Goal",
        String(goal || ""),
        "",
        "# Prior Worker Summary",
        lastSummary ? JSON.stringify(lastSummary) : "No worker has run yet.",
        "",
        "Return exactly one JSON object with action run, done, or escalate.",
      ].join("\n");

      let totalTokens = 0;
      let result = await ask(input);
      totalTokens += usageTokenCount(result.usage);
      try {
        return {
          decision: parseOrchestratorDecision(result.text, workers),
          usage: result.usage || {},
        };
      } catch (firstError) {
        result = await ask([
          input,
          "",
          `Your previous response was invalid: ${firstError.message}`,
          "Return ONLY the decision JSON object. Do not include prose.",
        ].join("\n"));
        totalTokens += usageTokenCount(result.usage);
        try {
          return {
            decision: parseOrchestratorDecision(result.text, workers),
            usage: { inputTokens: 0, outputTokens: totalTokens },
          };
        } catch (secondError) {
          return {
            decision: {
              action: "escalate",
              reason: `orchestrator produced no valid decision: ${secondError.message}`,
            },
            usage: { inputTokens: 0, outputTokens: totalTokens },
          };
        }
      }
    },
  };
}
