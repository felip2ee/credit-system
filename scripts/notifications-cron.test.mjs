import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./notifications-cron.mjs", import.meta.url));
const SECRET = "test-dispatch-secret-0123456789";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/dispatch` }));
  });
}

function runCron(env) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("exits with code 1 when the configuration is missing", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 1);
});

test("sends a POST with the Bearer header and never logs the secret", async () => {
  const seen = [];
  const { server, url } = await startServer((req, res) => {
    seen.push({ method: req.method, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end('{"sent":2}');
  });
  const cron = runCron({ NOTIFICATIONS_DISPATCH_URL: url, NOTIFICATIONS_DISPATCH_SECRET: SECRET });
  await sleep(700);
  cron.child.kill("SIGTERM");
  await new Promise((resolve) => cron.child.on("exit", resolve));
  server.close();

  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].auth, `Bearer ${SECRET}`);
  assert.match(cron.output(), /status=200/);
  assert.ok(!cron.output().includes(SECRET));
});

test("does not start a new call while the previous one is still running", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const { server, url } = await startServer((_req, res) => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      res.end("{}");
    }, 400);
  });
  const cron = runCron({
    NOTIFICATIONS_DISPATCH_URL: url,
    NOTIFICATIONS_DISPATCH_SECRET: SECRET,
    NOTIFICATIONS_CRON_INTERVAL_MS: "50",
  });
  await sleep(1000);
  cron.child.kill("SIGTERM");
  await new Promise((resolve) => cron.child.on("exit", resolve));
  server.close();

  assert.equal(maxInFlight, 1);
  assert.ok(calls >= 2);
});
