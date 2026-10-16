import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOpsAlerter, runOnce } from "./notifications-cron.mjs";

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

// --- Alertas por e-mail: iteração e alerter com fetch, sendMail, relógio e stat injetados ---

const ALERT_ENV = { OPS_ALERT_TO: "ops@example.test", SMTP_FROM: "reino@example.test" };
const HOUR_MS = 3_600_000;

function harness({ responses, env = ALERT_ENV, sendMail, backupStateFile, startAt = Date.UTC(2026, 9, 16, 12) }) {
  const sent = [];
  const logs = [];
  const clock = { at: startAt };
  const queue = [...responses];
  const fetch = async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => next.body ?? "{}" };
  };
  const alerter = createOpsAlerter({
    env,
    sendMail: sendMail ?? (async (message) => void sent.push(message)),
    now: () => clock.at,
    log: (line) => logs.push(line),
  });
  const state = {};
  const run = (targets = [{ name: "dispatch", url: "http://app:3000/dispatch", label: "" }]) =>
    runOnce({ targets, secret: SECRET, fetch, alerter, state, log: (line) => logs.push(line), now: () => clock.at, backupStateFile });
  return { sent, logs, clock, run, alerter };
}

test("five consecutive non 200 dispatch responses send one dispatch_down alert", async () => {
  const h = harness({ responses: [{ status: 503, body: "upstream secret-body" }] });
  for (let i = 0; i < 4; i++) await h.run();
  assert.equal(h.sent.length, 0);
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /\[reino\] dispatch indisponível/);
  assert.equal(h.sent[0].to, ALERT_ENV.OPS_ALERT_TO);
  assert.equal(h.sent[0].from, ALERT_ENV.SMTP_FROM);
  await h.run();
  assert.equal(h.sent.length, 1);
});

test("a 200 resets the consecutive failure count", async () => {
  const h = harness({ responses: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }, { status: 500 }] });
  for (let i = 0; i < 6; i++) await h.run();
  assert.equal(h.sent.length, 0);
});

test("network failure counts as non 200", async () => {
  const h = harness({ responses: [Object.assign(new Error("boom"), { name: "TypeError" })] });
  for (let i = 0; i < 5; i++) await h.run();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /falha de rede/);
});

test("tick failures alert with their own key", async () => {
  const h = harness({ responses: [{ status: 502 }] });
  const targets = [{ name: "tick", url: "http://app:3000/tick", label: "orders-tick " }];
  for (let i = 0; i < 5; i++) await h.run(targets);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /\[reino\] tick indisponível/);
});

test("same key within 60 minutes sends nothing", async () => {
  const h = harness({ responses: [{ status: 500 }] });
  for (let i = 0; i < 5; i++) await h.run();
  h.clock.at += 59 * 60_000;
  await h.run();
  assert.equal(h.sent.length, 1);
  h.clock.at += 2 * 60_000;
  await h.run();
  assert.equal(h.sent.length, 2);
});

test("failed greater than zero in dispatch body sends dispatch_failed", async () => {
  const h = harness({ responses: [{ status: 200, body: '{"claimed":3,"sent":1,"retried":0,"failed":2,"suppressed":0,"stale":0,"errors":0}' }] });
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /\[reino\] notificações falhando/);
  assert.match(h.sent[0].text, /failed: 2/);
});

test("failed equal to zero sends nothing", async () => {
  const h = harness({ responses: [{ status: 200, body: '{"claimed":3,"sent":3,"failed":0,"errors":0}' }] });
  await h.run();
  assert.equal(h.sent.length, 0);
});

test("errors greater than zero in a 500 dispatch body sends dispatch_failed on the first loop", async () => {
  const h = harness({ responses: [{ status: 500, body: '{"claimed":2,"sent":1,"retried":0,"failed":0,"suppressed":0,"stale":0,"errors":1}' }] });
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /\[reino\] notificações falhando/);
  assert.match(h.sent[0].text, /status HTTP: 500\n.*errors: 1/s);
});

test("tick errors greater than zero in a 500 body send tick_errors on the first loop", async () => {
  const h = harness({ responses: [{ status: 500, body: '{"processed":4,"errors":3}' }] });
  await h.run([{ name: "tick", url: "http://app:3000/tick", label: "orders-tick " }]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /\[reino\] tick com erros/);
  assert.match(h.sent[0].text, /status HTTP: 500\nerrors: 3/);
});

test("tick errors greater than zero send tick_errors", async () => {
  const h = harness({ responses: [{ status: 500, body: '{"processed":4,"errors":2}' }] });
  await h.run([{ name: "tick", url: "http://app:3000/tick", label: "orders-tick " }]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /\[reino\] tick com erros/);
  assert.match(h.sent[0].text, /errors: 2/);
});

function markerFile(ageMs, now) {
  const dir = mkdtempSync(join(tmpdir(), "cron-backup-"));
  const file = join(dir, "last-success");
  writeFileSync(file, "");
  utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
  return { dir, file };
}

test("stale backup marker sends backup_stale", async () => {
  const startAt = Date.now();
  const marker = markerFile(37 * HOUR_MS, startAt);
  try {
    const h = harness({ responses: [{ status: 200 }], backupStateFile: marker.file, startAt });
    await h.run();
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].subject, /\[reino\] backup atrasado/);
  } finally {
    rmSync(marker.dir, { recursive: true });
  }
});

test("fresh backup marker sends nothing", async () => {
  const startAt = Date.now();
  const marker = markerFile(2 * HOUR_MS, startAt);
  try {
    const h = harness({ responses: [{ status: 200 }], backupStateFile: marker.file, startAt });
    await h.run();
    assert.equal(h.sent.length, 0);
  } finally {
    rmSync(marker.dir, { recursive: true });
  }
});

test("missing backup marker sends nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-backup-"));
  try {
    const h = harness({ responses: [{ status: 200 }], backupStateFile: join(dir, "last-success") });
    await h.run();
    await h.run();
    assert.equal(h.sent.length, 0);
    assert.equal(h.logs.filter((line) => line.includes("marcador de backup ausente")).length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("missing OPS_ALERT_TO logs and sends nothing", async () => {
  const h = harness({ responses: [{ status: 500 }], env: {} });
  for (let i = 0; i < 6; i++) await h.run();
  assert.equal(h.sent.length, 0);
  assert.equal(h.logs.filter((line) => line.includes("OPS_ALERT_TO")).length, 1);
});

test("transport failure is logged and does not stop the loop", async () => {
  let attempts = 0;
  const h = harness({
    responses: [{ status: 500 }],
    sendMail: async () => {
      attempts += 1;
      throw Object.assign(new Error("smtp password hunter2"), { code: "ECONNECTION" });
    },
  });
  for (let i = 0; i < 6; i++) await h.run();
  assert.ok(attempts >= 1);
  assert.ok(h.logs.some((line) => line.includes("ECONNECTION")));
  assert.ok(!h.logs.join("\n").includes("hunter2"));
});

test("alert body never includes the response body", async () => {
  const h = harness({ responses: [{ status: 200, body: '{"failed":1,"sent":0,"note":"cpf 123.456.789-00 ana@example.com"}' }] });
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(h.sent[0].text, /cpf|ana@example|note/);
  assert.match(h.sent[0].text, /^chave: dispatch_failed\nstatus HTTP: 200\nsent: 0\nfailed: 1\nhorário: \d{4}-\d{2}-\d{2}T/);
});
