export function defaultConfig() {
  return {
    defaultModel: "minimax/MiniMax-M3",
    mavisDaemonPort: 15321,
    currentMavisSession: null,
    mavisCli: null,
    sessionDirectory: null,
    mvsMaxSendChars: 4000,
    requireProvider: "minimax",
    requireModel: "minimax/MiniMax-M3",
    maxTurns: 3,
    maxWallClockSec: 180,
    maxInputTokens: 200000,
    outputCapTokens: 8192,
    nearOutputCapRatio: 0.9,
    includeOptimizationContext: true,
    tinyCanaryInputEstimateTokens: 12000,
    maxLongPromptChars: 160000,
    maxLongPromptRepeats: 3,
    askSourceContextMode: "auto",
    askMaxSourceContextChars: 24000,
    duetPacketMaxChars: 60000,
    codexCli: process.platform === "win32" ? "codex.cmd" : "codex",
    codexStepTimeoutSec: 180,
    claudeCli: null,
    asciiConsole: true,
    denySessions: [],
    env: {
      MAVIS_PROMPT_CACHE_MODE: "enforce",
      MAVIS_CONTEXT_BUDGET_MODE: "enforce",
      MAVIS_CONTEXT_BUDGET_PROFILE: "max",
      MAVIS_PROMPT_CACHE_OPENROUTER: "",
    },
  };
}

export function parseConfigValue(value) {
  if (value === null || value === undefined) throw new Error("--value is required");
  const text = String(value);
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

export function validateNumberRange(configObject, key, min, max) {
  if (configObject[key] === null || configObject[key] === undefined) return;
  const value = Number(configObject[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number from ${min} to ${max}`);
  }
  configObject[key] = value;
}

export function validateConfig(configObject) {
  const defaults = defaultConfig();
  const allowedRootKeys = new Set(Object.keys(defaults));
  const allowedEnvKeys = new Set(Object.keys(defaults.env));
  for (const key of Object.keys(configObject)) {
    if (!allowedRootKeys.has(key)) throw new Error(`unknown config key: ${key}`);
  }
  for (const key of Object.keys(configObject.env || {})) {
    if (!allowedEnvKeys.has(key)) throw new Error(`unknown env config key: ${key}`);
  }
  validateNumberRange(configObject, "mavisDaemonPort", 1, 65535);
  validateNumberRange(configObject, "mvsMaxSendChars", 1, 20000);
  validateNumberRange(configObject, "maxTurns", 1, 10);
  validateNumberRange(configObject, "maxWallClockSec", 5, 600);
  validateNumberRange(configObject, "maxInputTokens", 1000, 10000000);
  validateNumberRange(configObject, "outputCapTokens", 128, 65536);
  validateNumberRange(configObject, "nearOutputCapRatio", 0.1, 1);
  validateNumberRange(configObject, "tinyCanaryInputEstimateTokens", 1, 1000000);
  validateNumberRange(configObject, "maxLongPromptChars", 100, 1000000);
  validateNumberRange(configObject, "maxLongPromptRepeats", 1, 10);
  validateNumberRange(configObject, "askMaxSourceContextChars", 0, 200000);
  validateNumberRange(configObject, "duetPacketMaxChars", 1000, 1000000);
  validateNumberRange(configObject, "codexStepTimeoutSec", 5, 1800);
  if (!["auto", "off"].includes(String(configObject.askSourceContextMode || "auto"))) {
    throw new Error("askSourceContextMode must be auto or off");
  }
  if (typeof configObject.defaultModel !== "string" || !configObject.defaultModel.trim()) {
    throw new Error("defaultModel must be a non-empty string");
  }
  if (typeof configObject.requireModel !== "string" || !configObject.requireModel.trim()) {
    throw new Error("requireModel must be a non-empty string");
  }
  if (typeof configObject.codexCli !== "string" || !configObject.codexCli.trim()) {
    throw new Error("codexCli must be a non-empty string");
  }
  if (configObject.claudeCli !== null && configObject.claudeCli !== undefined) {
    if (typeof configObject.claudeCli !== "string") throw new Error("claudeCli must be a string or null");
    if (!configObject.claudeCli.trim()) configObject.claudeCli = null;
  }
  if (configObject.requireProvider !== null && configObject.requireProvider !== undefined && typeof configObject.requireProvider !== "string") {
    throw new Error("requireProvider must be a string or null");
  }
  if (configObject.currentMavisSession && !/^mvs_[A-Za-z0-9_-]+$/.test(String(configObject.currentMavisSession))) {
    throw new Error("currentMavisSession must be null or mvs_<id>");
  }
  for (const sessionID of configObject.denySessions || []) {
    if (!/^mvs_[A-Za-z0-9_-]+$/.test(String(sessionID))) {
      throw new Error("denySessions entries must be mvs_<id>");
    }
  }
  if (typeof configObject.asciiConsole !== "boolean") throw new Error("asciiConsole must be boolean");
  if (typeof configObject.includeOptimizationContext !== "boolean") throw new Error("includeOptimizationContext must be boolean");
  const allowedProfile = new Set(["max", "medium", "free"]);
  const allowedMode = new Set(["enforce", "observe", "off"]);
  if (!allowedProfile.has(configObject.env?.MAVIS_CONTEXT_BUDGET_PROFILE)) {
    throw new Error("env.MAVIS_CONTEXT_BUDGET_PROFILE must be max, medium, or free");
  }
  for (const key of ["MAVIS_PROMPT_CACHE_MODE", "MAVIS_CONTEXT_BUDGET_MODE"]) {
    if (!allowedMode.has(configObject.env?.[key])) {
      throw new Error(`env.${key} must be enforce, observe, or off`);
    }
  }
  if (!["", "0", "1"].includes(String(configObject.env?.MAVIS_PROMPT_CACHE_OPENROUTER ?? ""))) {
    throw new Error("env.MAVIS_PROMPT_CACHE_OPENROUTER must be empty, 0, or 1");
  }
}

export function normalizeConfig(input) {
  const defaults = defaultConfig();
  const merged = { ...defaults, ...(input || {}) };
  merged.env = { ...defaults.env, ...(merged.env || {}) };
  merged.denySessions = Array.isArray(merged.denySessions) ? [...new Set(merged.denySessions)] : [];
  validateConfig(merged);
  return merged;
}
