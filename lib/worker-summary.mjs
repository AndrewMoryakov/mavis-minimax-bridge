function cappedText(text, maxChars) {
  const input = String(text || "");
  const limit = Math.max(0, Number(maxChars) || 0);
  return input.length > limit ? input.slice(0, limit) : input;
}

function synthesizeDid(rawOutput, maxSummaryChars) {
  const text = String(rawOutput || "");
  const limit = Math.max(0, Number(maxSummaryChars) || 0);
  if (text.length <= limit) return text;
  if (limit <= 20) return text.slice(0, limit);
  const half = Math.max(1, Math.floor((limit - 15) / 2));
  return `${text.slice(0, half)}\n...\n${text.slice(-half)}`.slice(0, limit);
}

function cleanArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((artifact) => ({
    path: String(artifact?.path || ""),
    sha256: String(artifact?.sha256 || ""),
    bytes: Number.isFinite(Number(artifact?.bytes)) ? Number(artifact.bytes) : 0,
  }));
}

export function buildWorkerSummary({
  worker,
  step,
  status,
  rawOutput,
  selfReport,
  artifacts,
  rawRef,
  maxSummaryChars,
}) {
  const reported = selfReport && typeof selfReport.did === "string" && selfReport.did.trim()
    ? selfReport.did
    : synthesizeDid(rawOutput, maxSummaryChars);
  const did = cappedText(reported, maxSummaryChars);
  return {
    worker: String(worker || ""),
    step: Number(step),
    status: status || "ok",
    did,
    artifacts: cleanArtifacts(artifacts),
    rawRef: rawRef || null,
    truncated: String(rawOutput || "").length > did.length || reported.length > did.length,
  };
}
