import path from "node:path";

export function makePaths(bridgeDir) {
  return {
    bridgeDir,
    configPath: path.join(bridgeDir, "config.json"),
    inboxPath: path.join(bridgeDir, "inbox.jsonl"),
    outboxPath: path.join(bridgeDir, "outbox.jsonl"),
    ledgerPath: path.join(bridgeDir, "ledger.jsonl"),
    duetStatePath: path.join(bridgeDir, "duet-state.json"),
    duetJournalPath: path.join(bridgeDir, "duet-journal.md"),
    duetLockPath: path.join(bridgeDir, "duet.lock"),
  };
}
