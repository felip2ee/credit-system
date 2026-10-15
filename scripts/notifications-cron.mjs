// Calls the notifications dispatch route every 60 s. Runs as its own Swarm service.
// Config: NOTIFICATIONS_DISPATCH_URL + NOTIFICATIONS_DISPATCH_SECRET (or *_FILE).
import { readFileSync } from "node:fs";

const MIN_INTERVAL_MS = 5_000;
// Abaixo do mínimo (ou valor inválido) o worker bateria na rota sem folga: sobe para o mínimo.
const INTERVAL_MS = Math.max(Number(process.env.NOTIFICATIONS_CRON_INTERVAL_MS) || 60_000, MIN_INTERVAL_MS);
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

// O Bearer viaja no pedido: http só vale em loopback ou em nome de serviço da rede interna (sem ponto, como http://app:3000).
function isCleartextExternal(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error("notifications-cron: NOTIFICATIONS_DISPATCH_URL is not a valid URL");
    process.exit(1);
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || !host.includes("."));
}

if (isCleartextExternal(url)) {
  if (process.env.NODE_ENV === "production") {
    console.error("notifications-cron: refusing http:// to a non-internal host in production (the Bearer would travel in clear)");
    process.exit(1);
  }
  console.warn("notifications-cron: NOTIFICATIONS_DISPATCH_URL uses http:// to a non-internal host; the Bearer travels in clear");
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
