function usageTokenCount(usage = {}) {
  const input = usage.inputTokens ?? usage.input_tokens ?? 0;
  const output = usage.outputTokens ?? usage.output_tokens ?? 0;
  return Math.max(0, Number(input) || 0) + Math.max(0, Number(output) || 0);
}

function errorSummary(worker, step, subtask, error) {
  return {
    worker,
    step,
    status: "error",
    did: `Worker failed: ${error?.message || error}`,
    artifacts: [],
    rawRef: null,
    truncated: false,
    subtask,
  };
}

export async function runOrchestratorLoop({
  orchestrator,
  workerRunner,
  budget,
  appendEvent,
  journal,
  initialSummary = null,
}) {
  let lastSummary = initialSummary;
  let steps = 0;

  while (budget.canStartStep() && budget.canStartCall(0)) {
    const step = budget.startStep();
    steps = step;
    const decisionResult = await orchestrator.decide(lastSummary);
    const decision = decisionResult.decision;
    budget.account(usageTokenCount(decisionResult.usage));
    appendEvent({ kind: "decision", step, decision, usage: decisionResult.usage || {} });
    if (journal) journal({ kind: "decision", step, decision });

    if (decision.action === "done") {
      appendEvent({ kind: "final", step, status: "done", summary: decision.summary || "", usage: {} });
      return { status: "done", steps };
    }

    if (decision.action === "escalate") {
      appendEvent({ kind: "final", step, status: "human_escalation", reason: decision.reason || "", usage: {} });
      return { status: "human_escalation", steps };
    }

    appendEvent({ kind: "worker-started", step, worker: decision.worker, subtask: decision.subtask });
    let workerResult;
    try {
      workerResult = await workerRunner.run(decision.worker, decision.subtask, { step });
    } catch (error) {
      workerResult = { summary: errorSummary(decision.worker, step, decision.subtask, error), usage: {} };
    }
    budget.account(usageTokenCount(workerResult.usage));
    lastSummary = workerResult.summary;
    appendEvent({
      kind: "worker-result",
      step,
      worker: decision.worker,
      subtask: decision.subtask,
      summary: workerResult.summary,
      usage: workerResult.usage || {},
    });
    if (journal) journal({ kind: "worker-result", step, summary: workerResult.summary });
  }

  appendEvent({ kind: "final", step: steps, status: "budget_exhausted", usage: {} });
  return { status: "budget_exhausted", steps };
}
