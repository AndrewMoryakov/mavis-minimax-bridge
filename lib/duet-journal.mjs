import fs from "node:fs";

export function readDuetJournalFile(journalPath) {
  if (!fs.existsSync(journalPath)) {
    throw new Error("duet journal is missing; restore duet-journal.md or run `duet init --force`");
  }
  const journal = fs.readFileSync(journalPath, "utf8");
  if (!journal.trim()) {
    throw new Error("duet journal is empty; restore duet-journal.md or run `duet init --force`");
  }
  return journal;
}

export function appendDuetJournalEntry(journalPath, markdown) {
  readDuetJournalFile(journalPath);
  const handle = fs.openSync(journalPath, "a");
  try {
    fs.writeSync(handle, `\n${markdown.trim()}\n`, null, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}
