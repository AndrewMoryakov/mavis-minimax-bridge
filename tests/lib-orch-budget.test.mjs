import assert from "node:assert/strict";
import test from "node:test";

import { makeBudget } from "../lib/orch-budget.mjs";

test("makeBudget tracks steps and tokens honestly", () => {
  const budget = makeBudget({ maxSteps: 2, maxTokens: 100 });
  assert.equal(budget.canStartStep(), true);
  assert.equal(budget.canStartCall(80), true);
  assert.equal(budget.startStep(), 1);
  assert.equal(budget.account(30), 30);
  assert.equal(budget.canStartCall(71), false);
  assert.equal(budget.startStep(), 2);
  assert.equal(budget.canStartStep(), false);
  assert.throws(() => budget.startStep(), /step budget exhausted/);
  assert.deepEqual(budget.spent(), { steps: 2, tokens: 30, maxSteps: 2, maxTokens: 100 });
});
