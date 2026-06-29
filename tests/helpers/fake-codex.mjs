#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
  });
}

const stdin = await readStdin();
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || !args[outputIndex + 1]) {
  process.stderr.write("missing --output-last-message\n");
  process.exit(2);
}

const outputPath = args[outputIndex + 1];
const capturePayload = JSON.stringify({
    args,
    stdin,
    env: {
      HOME: process.env.HOME ?? null,
      USERPROFILE: process.env.USERPROFILE ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      PATH: process.env.PATH ?? process.env.Path ?? null,
      MAVIS_FAKE_SECRET_TOKEN: process.env.MAVIS_FAKE_SECRET_TOKEN ?? null,
    },
  }, null, 2);
const defaultCapturePath = `${outputPath}.capture.json`;
fs.writeFileSync(defaultCapturePath, capturePayload, "utf8");

const capturePath = process.env.FAKE_CODEX_CAPTURE;
if (capturePath && capturePath !== defaultCapturePath) {
  fs.writeFileSync(capturePath, capturePayload, "utf8");
}

fs.writeFileSync(outputPath, "Status: running\n\nFake Codex handoff from shim.", "utf8");
process.stdout.write(`${JSON.stringify({ type: "usage", usage: { input_tokens: 123, cached_input_tokens: 45, output_tokens: 67 } })}\n`);
process.exit(0);
