export function makeBudget({ maxSteps, maxTokens } = {}) {
  const stepsLimit = Number.isFinite(Number(maxSteps)) ? Number(maxSteps) : 20;
  const tokenLimit = Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : 200000;
  let steps = 0;
  let tokens = 0;

  return {
    canStartStep() {
      return steps < stepsLimit;
    },
    canStartCall(reserveTokens = 0) {
      const reserve = Math.max(0, Number(reserveTokens) || 0);
      return tokens + reserve <= tokenLimit;
    },
    startStep() {
      if (!this.canStartStep()) throw new Error(`orchestrator step budget exhausted: ${steps}/${stepsLimit}`);
      steps += 1;
      return steps;
    },
    account(usageTokens = 0) {
      tokens += Math.max(0, Number(usageTokens) || 0);
      return tokens;
    },
    spent() {
      return { steps, tokens, maxSteps: stepsLimit, maxTokens: tokenLimit };
    },
  };
}
