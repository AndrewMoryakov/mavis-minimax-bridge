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

  const config = normalizeConfig({});
  assert.doesNotThrow(() => validateConfig(config));
});
