import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { makeMvsClient, mvsBase, usageSummary } from "../lib/mvs-client.mjs";

function startServer(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => {
        server.closeAllConnections?.();
        server.close();
      });
      resolve(server.address().port);
    });
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function client(over = {}, runJson = () => ({})) {
  const config = {
    mavisDaemonPort: 15321,
    sessionDirectory: "/work/space",
    denySessions: [],
    mavisCli: "mavis-test",
    ...over,
  };
  return makeMvsClient({ config, runJson });
}

test("mvsBase builds the api base url", () => {
  assert.equal(mvsBase(15321), "http://127.0.0.1:15321/mavis/api");
});

test("usageSummary normalizes summary and last row", () => {
  const summary = usageSummary({
    summary: { turns: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    rows: [{ model: "minimax/m2", inputTokens: 40, outputTokens: 20 }],
  });
  assert.equal(summary.turns, 2);
  assert.equal(summary.inputTokens, 100);
  assert.equal(summary.last.provider, "minimax");
  assert.equal(summary.last.model, "minimax/m2");
});

test("session-id validators enforce format and deny-list", () => {
  const c = client({ denySessions: ["mvs_denied"] });
  assert.equal(c.isDeniedSession("mvs_denied"), true);
  assert.equal(c.isDeniedSession("mvs_ok"), false);
  assert.throws(() => c.assertNotDeniedSession("mvs_denied", "test"), /denied session/);
  assert.doesNotThrow(() => c.assertNotDeniedSession("mvs_ok", "test"));
  assert.throws(() => c.assertMvsSessionID("not-mvs"), /requires --session mvs_/);
  assert.doesNotThrow(() => c.assertMvsSessionID("mvs_abc123"));
});

test("session url helpers derive from config sessionDirectory", () => {
  const c = client({ sessionDirectory: "/work/space" });
  assert.equal(c.sessionDirectory(), "/work/space");
  assert.equal(c.sessionDirectory("/task/workspace"), "/task/workspace");
  assert.equal(c.sessionQuery(), `directory=${encodeURIComponent("/work/space")}`);
  assert.equal(c.sessionQuery("/task/workspace"), `directory=${encodeURIComponent("/task/workspace")}`);
  assert.match(c.messageUrl(15321, "mvs_x"), /\/session\/mvs_x\/message\?directory=/);
  assert.match(c.messageUrl(15321, "mvs_x", { directory: "/task/workspace" }), new RegExp(encodeURIComponent("/task/workspace")));
});

test("mavisCli prefers the configured path", () => {
  assert.equal(client({ mavisCli: "/opt/mavis" }).mavisCli(), "/opt/mavis");
});

test("fetchMavisJson hits the mavis api base and parses json", async (t) => {
  const port = await startServer(t, (req, res) => {
    assert.equal(req.url, "/mavis/api/ping");
    jsonResponse(res, 200, { pong: true });
  });
  const c = client({ mavisDaemonPort: port });
  assert.deepEqual(await c.fetchMavisJson("/ping", { port }, 5), { pong: true });
});

test("verifyMavisSession returns resolved session and rejects mismatch", async (t) => {
  const port = await startServer(t, (req, res) => {
    const id = decodeURIComponent(req.url.split("/").pop());
    jsonResponse(res, 200, { session: { sessionId: id === "mvs_other" ? "mvs_different" : id } });
  });
  const c = client({ mavisDaemonPort: port });

  const ok = await c.verifyMavisSession(port, "mvs_self");
  assert.equal(ok.resolvedSession, "mvs_self");

  await assert.rejects(c.verifyMavisSession(port, "mvs_other"), /session mismatch/);
});

test("createSession posts to the session endpoint", async (t) => {
  const port = await startServer(t, (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, `/session?directory=${encodeURIComponent("/task/workspace")}`);
    jsonResponse(res, 200, { id: "mvs_new" });
  });
  const c = client({ mavisDaemonPort: port });
  assert.deepEqual(await c.createSession(port, "title", { directory: "/task/workspace" }), { id: "mvs_new" });
});

test("readUsage skips non-mavis and denied sessions, summarizes valid ones", () => {
  let calls = 0;
  const c = client(
    { denySessions: ["mvs_denied"] },
    () => {
      calls += 1;
      return { summary: { turns: 1, inputTokens: 10, outputTokens: 5 }, rows: [] };
    },
  );
  assert.equal(c.readUsage("").skipped, true);
  assert.equal(c.readUsage("plain-id").skipped, true);
  assert.equal(c.readUsage("mvs_denied").skipped, true);
  assert.equal(c.readUsage("mvs_bad&echo boom").skipped, true);
  assert.equal(calls, 0);

  const ok = c.readUsage("mvs_good");
  assert.equal(ok.skipped, false);
  assert.equal(ok.summary.turns, 1);
  assert.equal(calls, 1);
});
