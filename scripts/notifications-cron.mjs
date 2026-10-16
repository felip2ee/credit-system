// Calls the notifications dispatch route every 60 s. Runs as its own Swarm service.
// Config: NOTIFICATIONS_DISPATCH_URL + NOTIFICATIONS_DISPATCH_SECRET (or *_FILE).
// Optional: ORDERS_TICK_URL (same secret) makes the loop call the orders tick right after each dispatch.
// Optional alerts by e-mail: OPS_ALERT_TO + SMTP_HOST/PORT/SECURE/USER/FROM + SMTP_PASS_FILE, BACKUP_STATE_FILE.
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateSecretEnv } from "../src/lib/runtime-secrets.mjs";

const MIN_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 55_000;
const MAX_LOGGED_BODY = 200;
const ALERT_WINDOW_MS = 60 * 60_000;
const FAILED_SEND_RETRY_MS = 5 * 60_000;
const SMTP_TIMEOUT_MS = 10_000;
const CONSECUTIVE_FAILURES_TO_ALERT = 5;
const BACKUP_MAX_AGE_MS = 36 * 60 * 60_000;
const DISPATCH_COUNTS = ["claimed", "sent", "retried", "failed", "suppressed", "stale", "errors"];

const SUBJECTS = {
  dispatch_down: "[reino] dispatch indisponível",
  tick_down: "[reino] tick indisponível",
  dispatch_failed: "[reino] notificações falhando",
  tick_errors: "[reino] tick com erros",
  backup_stale: "[reino] backup atrasado",
};

function log(message) {
  console.log(`${new Date().toISOString()} notifications-cron: ${message}`);
}

// Alertas por e-mail com janela de 60 min por chave. Falha de transporte só é registrada: o loop segue.
export function createOpsAlerter({ env, sendMail, now = Date.now, log: logger = log }) {
  const lastSentAt = new Map();
  const lastFailedAt = new Map();
  let missingRecipientLogged = false;
  return {
    async alert(key, subject, body) {
      if (!env.OPS_ALERT_TO) {
        if (!missingRecipientLogged) logger("OPS_ALERT_TO ausente: alertas por e-mail desligados");
        missingRecipientLogged = true;
        return;
      }
      const at = now();
      const previous = lastSentAt.get(key);
      if (previous !== undefined && at - previous < ALERT_WINDOW_MS) return;
      const failedAt = lastFailedAt.get(key);
      if (failedAt !== undefined && at - failedAt < FAILED_SEND_RETRY_MS) return;
      try {
        await sendMail({ from: env.SMTP_FROM, to: env.OPS_ALERT_TO, subject, text: body });
        lastSentAt.set(key, at);
        logger(`alerta enviado: ${key}`);
      } catch (error) {
        lastFailedAt.set(key, at);
        logger(`falha ao enviar alerta ${key}: ${error?.code ?? error?.name ?? "error"}`);
      }
    },
  };
}

// O corpo do alerta leva só chave, status HTTP, contagens e horário: nunca o corpo da resposta.
function alertBody(key, fields, at) {
  const lines = [`chave: ${key}`];
  for (const [name, value] of Object.entries(fields)) lines.push(`${name}: ${value}`);
  lines.push(`horário: ${new Date(at).toISOString()}`);
  return lines.join("\n");
}

function pickCounts(json, names) {
  const counts = {};
  for (const name of names) if (Number.isFinite(json?.[name])) counts[name] = json[name];
  return counts;
}

// Chama um alvo e devolve { status, json }; status null = falha de rede ou timeout.
async function callOnce({ target, label, secret, fetch, log: logger }) {
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    logger(`${label}status=${response.status} body=${text.slice(0, MAX_LOGGED_BODY)}`);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // corpo que não é JSON só conta pelo status
    }
    return { status: response.status, json };
  } catch (error) {
    logger(`${label}request failed: ${error.name}`);
    return { status: null, json: null };
  }
}

async function checkBackup({ backupStateFile, stat: statFile, alerter, state, now, log: logger }) {
  if (!backupStateFile) return;
  let modifiedAt;
  try {
    modifiedAt = (await statFile(backupStateFile)).mtimeMs;
  } catch {
    // Sem marcador o primeiro backup ainda não rodou: não alerta.
    if (!state.backupMissingLogged) logger("marcador de backup ausente: sem alerta até o primeiro backup");
    state.backupMissingLogged = true;
    return;
  }
  state.backupMissingLogged = false;
  const at = now();
  const ageMs = at - modifiedAt;
  if (ageMs <= BACKUP_MAX_AGE_MS) return;
  await alerter.alert("backup_stale", SUBJECTS.backup_stale, alertBody("backup_stale", { "idade em horas": Math.floor(ageMs / 3_600_000) }, at));
}

// Uma iteração: dispatch, tick opcional e checagem do marcador de backup. `state` guarda os contadores entre iterações.
export async function runOnce({
  targets,
  secret,
  fetch = globalThis.fetch,
  alerter,
  state,
  log: logger = log,
  now = Date.now,
  backupStateFile,
  stat: statFile = stat,
}) {
  state.failures ??= new Map();
  for (const { name, url: target, label } of targets) {
    const { status, json } = await callOnce({ target, label, secret, fetch, log: logger });
    const downKey = `${name}_down`;
    // Só falha de rede ou resposta não-200 sem JSON conta como "fora do ar"; 500 com JSON é erro de execução (alerta próprio).
    const isDown = status === null || (status !== 200 && json === null);
    const consecutive = !isDown ? 0 : (state.failures.get(downKey) ?? 0) + 1;
    state.failures.set(downKey, consecutive);
    if (consecutive >= CONSECUTIVE_FAILURES_TO_ALERT) {
      const fields = { "status HTTP": status ?? "falha de rede", "falhas consecutivas": consecutive };
      await alerter.alert(downKey, SUBJECTS[downKey], alertBody(downKey, fields, now()));
    }
    if (name === "dispatch" && (json?.failed > 0 || json?.errors > 0)) {
      await alerter.alert("dispatch_failed", SUBJECTS.dispatch_failed, alertBody("dispatch_failed", { "status HTTP": status, ...pickCounts(json, DISPATCH_COUNTS) }, now()));
    }
    if (name === "tick" && json?.errors > 0) {
      await alerter.alert("tick_errors", SUBJECTS.tick_errors, alertBody("tick_errors", { "status HTTP": status, ...pickCounts(json, ["errors"]) }, now()));
    }
  }
  await checkBackup({ backupStateFile, stat: statFile, alerter, state, now, log: logger });
}

function readSecret() {
  const file = process.env.NOTIFICATIONS_DISPATCH_SECRET_FILE;
  const value = file ? readFileSync(file, "utf8") : process.env.NOTIFICATIONS_DISPATCH_SECRET;
  return (value ?? "").trim();
}

// O Bearer viaja no pedido: http só vale em loopback ou em nome de serviço da rede interna (sem ponto, como http://app:3000).
function isCleartextExternal(rawUrl, name) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`notifications-cron: ${name} is not a valid URL`);
    process.exit(1);
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || !host.includes("."));
}

// Timeouts curtos: um SMTP que não responde não pode travar o loop. Porta sem TLS implícito exige STARTTLS.
export function smtpTransportOptions(env) {
  const secure = env.SMTP_SECURE === "true";
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure,
    ...(secure ? {} : { requireTLS: true }),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  };
}

// Sem OPS_ALERT_TO ou sem SMTP utilizável o alerter só registra: o cron nunca cai por causa de alerta.
async function buildSendMail() {
  if (!process.env.OPS_ALERT_TO) return async () => {};
  try {
    const env = hydrateSecretEnv({ ...process.env });
    const { default: nodemailer } = await import("nodemailer");
    const transport = nodemailer.createTransport(smtpTransportOptions(env));
    return (message) => transport.sendMail(message);
  } catch (error) {
    log(`SMTP indisponível, alertas desligados: ${error?.code ?? error?.name ?? "error"}`);
    return async () => {
      throw error;
    };
  }
}

async function main() {
  // Abaixo do mínimo (ou valor inválido) o worker bateria na rota sem folga: sobe para o mínimo.
  const intervalMs = Math.max(Number(process.env.NOTIFICATIONS_CRON_INTERVAL_MS) || 60_000, MIN_INTERVAL_MS);
  let url;
  let secret;
  const tickUrl = process.env.ORDERS_TICK_URL || null;
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

  for (const [name, value] of [["NOTIFICATIONS_DISPATCH_URL", url], ["ORDERS_TICK_URL", tickUrl]]) {
    if (!value || !isCleartextExternal(value, name)) continue;
    if (process.env.NODE_ENV === "production") {
      console.error(`notifications-cron: refusing http:// to a non-internal host in production (the Bearer would travel in clear): ${name}`);
      process.exit(1);
    }
    console.warn(`notifications-cron: ${name} uses http:// to a non-internal host; the Bearer travels in clear`);
  }

  let stopped = false;
  let timer;
  process.on("SIGTERM", () => {
    stopped = true;
    clearTimeout(timer);
    log("SIGTERM received, stopping");
    process.exit(0);
  });

  const targets = [{ name: "dispatch", url, label: "" }];
  if (tickUrl) targets.push({ name: "tick", url: tickUrl, label: "orders-tick " });
  const alerter = createOpsAlerter({ env: process.env, sendMail: await buildSendMail() });
  const state = {};

  // Sequential loop: the next call starts only after the previous one ends.
  while (!stopped) {
    await runOnce({ targets, secret, alerter, state, backupStateFile: process.env.BACKUP_STATE_FILE });
    await new Promise((resolve) => {
      timer = setTimeout(resolve, intervalMs);
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
