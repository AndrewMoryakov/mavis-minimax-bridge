import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultConfig,
  normalizeConfig,
  parseConfigValue,
  validateConfig,
  validateNumberRange,
} from "../lib/config-core.mjs";

test("defaultConfig returns independent defaults", () => {
  const first = defaultConfig();
  const second = defaultConfig();
  first.env.MAVIS_CONTEXT_BUDGET_PROFILE = "free";
  first.denySessions.push("mvs_first");

  assert.equal(second.env.MAVIS_CONTEXT_BUDGET_PROFILE, "max");
  assert.deepEqual(second.denySessions, []);
});

test("normalizeConfig merges env defaults and dedupes deny sessions", () => {
  const config = normalizeConfig({
    maxTurns: "4",
    env: { MAVIS_CONTEXT_BUDGET_PROFILE: "medium" },
    denySessions: ["mvs_a", "mvs_a", "mvs_b"],
  });

  assert.equal(config.maxTurns, 4);
  assert.equal(config.env.MAVIS_CONTEXT_BUDGET_PROFILE, "medium");
  assert.equal(config.env.MAVIS_PROMPT_CACHE_MODE, "enforce");
  assert.deepEqual(config.denySessions, ["mvs_a", "mvs_b"]);
  assert.equal(config.claudeCli, null);
  assert.equal(config.claudeCliSearchTimeoutMs, 5000);
  assert.equal(config.claudeRunnerTimeoutMs, 60000);
  assert.equal(config.claudeRequireAvailable, false);
  assert.equal(config.claudeModel, null);
  assert.equal(config.claudeMaxTurns, 12);
  assert.equal(config.claudeMaxBudgetUsd, null);
  assert.equal(config.claudePermissionMode, "deny");
});

test("parseConfigValue parses JSON scalars and preserves plain strings", () => {
  assert.equal(parseConfigValue("false"), false);
  assert.equal(parseConfigValue("42"), 42);
  assert.deepEqual(parseConfigValue("{\"a\":1}"), { a: 1 });
  assert.equal(parseConfigValue("plain"), "plain");
  assert.throws(() => parseConfigValue(null), /--value is required/);
});

test("validateNumberRange mutates numeric values and rejects invalid values", () => {
  const config = { maxTurns: "5" };
  validateNumberRange(config, "maxTurns", 1, 10);
  assert.equal(config.maxTurns, 5);

  assert.throws(() => validateNumberRange({ maxTurns: 99 }, "maxTurns", 1, 10), /maxTurns must be a number/);
});

test("validateConfig rejects invalid config shapes", () => {
  assert.throws(() => normalizeConfig({ maxTurns: 99 }), /maxTurns must be a number/);
  assert.throws(() => normalizeConfig({ asciiConsole: "yes" }), /asciiConsole must be boolean/);
  assert.throws(() => normalizeConfig({ currentMavisSession: "bad" }), /currentMavisSession/);
  assert.throws(
    () => normalizeConfig({ env: { MAVIS_CONTEXT_BUDGET_PROFILE: "turbo" } }),
    /MAVIS_CONTEXT_BUDGET_PROFILE/,
  );
  assert.throws(() => normalizeConfig({ maxInputToken: 123 }), /unknown config key: maxInputToken/);
  assert.throws(() => normalizeConfig({ claudeCli: 123 }), /claudeCli/);
  assert.throws(() => normalizeConfig({ claudeCliSearchTimeoutMs: 99 }), /claudeCliSearchTimeoutMs/);
  assert.throws(() => normalizeConfig({ claudeRunnerTimeoutMs: 999 }), /claudeRunnerTimeoutMs/);
  assert.throws(() => normalizeConfig({ claudeRequireAvailable: "yes" }), /claudeRequireAvailable/);
  assert.throws(() => normalizeConfig({ claudeModel: 123 }), /claudeModel/);
  assert.throws(() => normalizeConfig({ claudeMaxTurns: 0 }), /claudeMaxTurns/);
  assert.throws(() => normalizeConfig({ claudeMaxTurns: 51 }), /claudeMaxTurns/);
  assert.throws(() => normalizeConfig({ claudeMaxTurns: 1.5 }), /claudeMaxTurns/);
  assert.throws(() => normalizeConfig({ claudeMaxBudgetUsd: 0 }), /claudeMaxBudgetUsd/);
  assert.throws(() => normalizeConfig({ claudePermissionMode: "allow" }), /claudePermissionMode/);
  assert.throws(
    () => normalizeConfig({ env: { MAVIS_CONTEXT_BUDGET_PROFIL: "max" } }),
    /unknown env config key: MAVIS_CONTEXT_BUDGET_PROFIL/,
  );

  assert.equal(normalizeConfig({ claudeCli: "" }).claudeCli, null);
  assert.equal(normalizeConfig({ claudeCli: "claude-custom" }).claudeCli, "claude-custom");
  assert.equal(normalizeConfig({ claudeModel: "" }).claudeModel, null);
  assert.equal(normalizeConfig({ claudeModel: "sonnet" }).claudeModel, "sonnet");
  assert.equal(normalizeConfig({ claudeMaxBudgetUsd: "0.25" }).claudeMaxBudgetUsd, 0.25);
  assert.equal(normalizeConfig({ claudeMaxTurns: "2" }).claudeMaxTurns, 2);

  const config = normalizeConfig({});
  assert.doesNotThrow(() => validateConfig(config));
});
