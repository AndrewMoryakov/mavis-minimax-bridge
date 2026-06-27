import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "../..");
const skipRelayCheck = process.argv.includes("--skip-relay-check");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function checksum(answerWithoutChecksum) {
  return crypto.createHash("sha256").update(canonicalJson(answerWithoutChecksum)).digest("hex");
}

function buildExpected(input) {
  const seen = new Set();
  const duplicateOrderIds = [];
  const unique = [];

  for (const order of input.orders) {
    if (seen.has(order.id)) {
      if (!duplicateOrderIds.includes(order.id)) {
        duplicateOrderIds.push(order.id);
      }
      continue;
    }

    seen.add(order.id);
    unique.push(order);
  }

  const totalsByCurrency = {};
  const customers = {};

  for (const order of unique) {
    totalsByCurrency[order.currency] ??= { count: 0, totalAmount: 0 };
    totalsByCurrency[order.currency].count += 1;
    totalsByCurrency[order.currency].totalAmount = roundMoney(totalsByCurrency[order.currency].totalAmount + order.amount);

    customers[order.customer] ??= { customer: order.customer, totalAmount: 0, orderCount: 0 };
    customers[order.customer].totalAmount = roundMoney(customers[order.customer].totalAmount + order.amount);
    customers[order.customer].orderCount += 1;
  }

  const topCustomer = Object.values(customers).sort((left, right) => {
    if (right.totalAmount !== left.totalAmount) {
      return right.totalAmount - left.totalAmount;
    }
    return left.customer.localeCompare(right.customer);
  })[0];

  const answerWithoutChecksum = {
    uniqueOrderCount: unique.length,
    duplicateOrderIds,
    totalAmount: roundMoney(unique.reduce((sum, order) => sum + order.amount, 0)),
    totalsByCurrency,
    topCustomer,
    orderIds: unique.map((order) => order.id),
  };

  return {
    ...answerWithoutChecksum,
    checksum: checksum(answerWithoutChecksum),
  };
}

function verifyRelay() {
  const statePath = path.join(repoRoot, "duet-state.json");
  const journalPath = path.join(repoRoot, "duet-journal.md");

  assert.equal(fs.existsSync(statePath), true, "duet-state.json must exist");
  assert.equal(fs.existsSync(journalPath), true, "duet-journal.md must exist");

  const state = readJson(statePath);
  const journal = fs.readFileSync(journalPath, "utf8");

  assert.equal(state.status, "done", "duet status must be done");
  assert.equal(state.baton, null, "done relay must not keep a baton holder");
  assert.ok(state.iteration >= 2, "relay must include at least one baton pass");
  assert.match(journal, /codex/i, "journal must mention Codex contribution");
  assert.match(journal, /minimax/i, "journal must mention MiniMax contribution");
}

const input = readJson(path.join(taskDir, "input.json"));
const actualPath = path.join(taskDir, "answer.json");

assert.equal(fs.existsSync(actualPath), true, "answer.json must exist");
assert.deepEqual(readJson(actualPath), buildExpected(input));

if (!skipRelayCheck) {
  verifyRelay();
}

console.log("PASS duet-simple-orders");
