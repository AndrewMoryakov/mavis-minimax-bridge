import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { fetchJson, fetchJsonWithTimeout } from "../lib/http-json.mjs";

function startServer(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => {
        server.closeAllConnections?.();
        server.close();
      });
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test("fetchJson parses a JSON success response", async (t) => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: 7 }));
  });
  assert.deepEqual(await fetchJson(url), { ok: true, value: 7 });
});

test("fetchJson throws with status and body on a non-ok response", async (t) => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(503);
    res.end("backend down");
  });
  await assert.rejects(fetchJson(url), /503.*backend down/);
});

test("fetchJson throws a descriptive error on non-JSON body", async (t) => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(200);
    res.end("this is not json");
  });
  await assert.rejects(fetchJson(url), /expected JSON from/);
});

test("fetchJsonWithTimeout returns the parsed body when the server responds", async (t) => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  assert.deepEqual(await fetchJsonWithTimeout(url, {}, 30), { ok: true });
});

test("fetchJsonWithTimeout aborts and throws after the timeout elapses", async (t) => {
  const url = await startServer(t, () => {
    // Never respond, forcing the AbortController to fire.
  });
  await assert.rejects(fetchJsonWithTimeout(url, {}, 0.2), /timeout after 0\.2s/);
});
