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
  fs.appendFileSync(journalPath, `\n${markdown.trim()}\n`, "utf8");
}
