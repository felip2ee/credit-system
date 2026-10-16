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

test("clamps the interval to 5 s and never overlaps calls", async () => {
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
  // 50 ms pedidos: com o mínimo de 5 s só a primeira chamada cabe em 1 s.
  assert.equal(calls, 1);
});

test("warns about http:// to an external host and refuses it in production", () => {
  const env = { PATH: process.env.PATH, NOTIFICATIONS_DISPATCH_URL: "http://dispatch.example.com/x", NOTIFICATIONS_DISPATCH_SECRET: SECRET };
  const refused = spawnSync(process.execPath, [SCRIPT], { env: { ...env, NODE_ENV: "production" }, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing http/);
});

test("accepts http:// to a service name or loopback in production", async () => {
  const { server, url } = await startServer((_req, res) => res.end("{}"));
  const cron = runCron({ NOTIFICATIONS_DISPATCH_URL: url, NOTIFICATIONS_DISPATCH_SECRET: SECRET, NODE_ENV: "production" });
  await sleep(500);
  cron.child.kill("SIGTERM");
  await new Promise((resolve) => cron.child.on("exit", resolve));
  server.close();

  assert.match(cron.output(), /status=200/);
});

test("calls ORDERS_TICK_URL right after the dispatch with the same Bearer", async () => {
  const seen = [];
  const { server, url } = await startServer((req, res) => {
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization });
    res.end("{}");
  });
  const cron = runCron({
    NOTIFICATIONS_DISPATCH_URL: url,
    ORDERS_TICK_URL: url.replace("/dispatch", "/tick"),
    NOTIFICATIONS_DISPATCH_SECRET: SECRET,
  });
  await sleep(700);
  cron.child.kill("SIGTERM");
  await new Promise((resolve) => cron.child.on("exit", resolve));
  server.close();

  assert.deepEqual(
    seen.map((call) => [call.path, call.method, call.auth]),
    [
      ["/dispatch", "POST", `Bearer ${SECRET}`],
      ["/tick", "POST", `Bearer ${SECRET}`],
    ],
  );
  assert.match(cron.output(), /orders-tick status=200/);
  assert.ok(!cron.output().includes(SECRET));
});

test("does not call any tick without ORDERS_TICK_URL", async () => {
  const paths = [];
  const { server, url } = await startServer((req, res) => {
    paths.push(req.url);
    res.end("{}");
  });
  const cron = runCron({ NOTIFICATIONS_DISPATCH_URL: url, NOTIFICATIONS_DISPATCH_SECRET: SECRET });
  await sleep(700);
  cron.child.kill("SIGTERM");
  await new Promise((resolve) => cron.child.on("exit", resolve));
  server.close();

  assert.deepEqual(paths, ["/dispatch"]);
  assert.ok(!cron.output().includes("orders-tick"));
});

test("refuses an external http:// ORDERS_TICK_URL in production", () => {
  const refused = spawnSync(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      NOTIFICATIONS_DISPATCH_URL: "http://127.0.0.1:9/dispatch",
      ORDERS_TICK_URL: "http://tick.example.com/x",
      NOTIFICATIONS_DISPATCH_SECRET: SECRET,
    },
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing http.*ORDERS_TICK_URL/);
});
