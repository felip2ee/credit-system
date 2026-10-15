// Calls the notifications dispatch route every 60 s. Runs as its own Swarm service.
// Config: NOTIFICATIONS_DISPATCH_URL + NOTIFICATIONS_DISPATCH_SECRET (or *_FILE).
import { readFileSync } from "node:fs";

const INTERVAL_MS = Number(process.env.NOTIFICATIONS_CRON_INTERVAL_MS) || 60_000;
const TIMEOUT_MS = 55_000;
const MAX_LOGGED_BODY = 200;

function log(message) {
  console.log(`${new Date().toISOString()} notifications-cron: ${message}`);
}

function readSecret() {
  const file = process.env.NOTIFICATIONS_DISPATCH_SECRET_FILE;
  const value = file ? readFileSync(file, "utf8") : process.env.NOTIFICATIONS_DISPATCH_SECRET;
  return (value ?? "").trim();
}

let url;
let secret;
try {
  url = process.env.NOTIFICATIONS_DISPATCH_URL;
  secret = readSecret();
} catch (error) {
  console.error(`notifications-cron: cannot read the secret file (${error.code ?? "error"})`);
  process.exit(1);
}
if (!url || !secret) {
  console.error("notifications-cron: NOTIFICATIONS_DISPATCH_URL and the dispatch secret are required");
  process.exit(1);
}

let stopped = false;
let timer;
process.on("SIGTERM", () => {
  stopped = true;
  clearTimeout(timer);
  log("SIGTERM received, stopping");
  process.exit(0);
});

async function dispatchOnce() {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.text()).slice(0, MAX_LOGGED_BODY);
    log(`status=${response.status} body=${body}`);
  } catch (error) {
    log(`request failed: ${error.name}`);
  }
}

// Sequential loop: the next call starts only after the previous one ends.
while (!stopped) {
  await dispatchOnce();
  await new Promise((resolve) => {
    timer = setTimeout(resolve, INTERVAL_MS);
  });
}
