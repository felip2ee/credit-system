import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { Pool } from "pg";

import { assertE2eDatabase } from "./db-guard";

export { assertE2eDatabase };

// Everything the e2e run seeds carries the `e2e-` prefix; global-setup deletes it at the start of each run.
export const E2E = {
  bureauSlug: "e2e-bureau",
  staff: { email: "e2e-staff@example.test", password: "e2e-staff-password-123" },
  client: {
    email: "e2e-client@example.test",
    password: "e2e-client-password-123",
    cpf: "529.982.247-25",
    phone: "+5511999990001",
  },
  disabled: { email: "e2e-disabled@example.test", password: "e2e-disabled-password-123" },
  product: "consulta_pf",
  salePrice: "20.00",
} as const;

// A tick sweeps every Bureau with due work, so one pass can take several seconds on a shared database.
export const TICK_POLL_TIMEOUT_MS = 90_000;

export const AUTH_DIR = "e2e/.auth";
export const STAFF_STATE = `${AUTH_DIR}/staff.json`;
export const STAFF_SECRET_FILE = `${AUTH_DIR}/staff-secret.txt`;
export const CLIENT_STATE = `${AUTH_DIR}/client.json`;

export const DATABASE_OWNER_URL =
  process.env.TEST_DATABASE_OWNER_URL ?? "postgres://postgres:test@127.0.0.1:54329/credit_system";

let pool: Pool | undefined;

export async function dbQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!pool) assertE2eDatabase(DATABASE_OWNER_URL);
  pool ??= new Pool({ connectionString: DATABASE_OWNER_URL, max: 2 });
  return (await pool.query(sql, params)).rows as T[];
}

// Runs one orders tick, as the cron does. Only a 401 is a setup error: the tick answers 500 when any other
// Bureau on a shared dev database has a failing step.
export async function runTick(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/internal/orders/tick", {
    headers: { Authorization: `Bearer ${process.env.NOTIFICATIONS_DISPATCH_SECRET}` },
  });
  expect(response.status(), "orders tick must accept the dispatch secret").not.toBe(401);
}

export async function orderState(dossierId: string): Promise<string | undefined> {
  const rows = await dbQuery<{ state: string }>("select state from dossier_orders where dossier_id = $1", [dossierId]);
  return rows[0]?.state;
}

// Ticks until the SCR request is issued, then answers it on the public page like the holder would.
export async function authorizeScr(page: Page, request: APIRequestContext, dossierId: string): Promise<void> {
  const scrOf = async () =>
    (
      await dbQuery<{ auth_code: string | null; public_token: string | null }>(
        `select s.auth_code, s.public_token from scr_authorizations s
           join consultations c on c.scr_authorization_id = s.id
          where c.dossier_id = $1`,
        [dossierId],
      )
    )[0];
  await expect
    .poll(async () => {
      await runTick(request);
      return (await scrOf())?.auth_code ?? null;
    }, { message: "tick issues the SCR request", timeout: TICK_POLL_TIMEOUT_MS, intervals: [1_000] })
    .not.toBeNull();
  const scr = await scrOf();
  await page.goto(`/autorizacao-scr/${scr?.public_token}`);
  await page.getByLabel("Código de confirmação").fill(scr?.auth_code ?? "");
  await page.getByRole("button", { name: "Autorizar" }).click();
  // The action revalidates the page, so the form may be replaced by the "already granted" notice.
  await expect(page.getByText(/Autorização concedida com sucesso|Esta autorização já foi concedida/)).toBeVisible();
}

// better-auth limits sign-ins per IP (3 per 10 s) and every e2e request comes from 127.0.0.1.
export async function resetRateLimit(): Promise<void> {
  await dbQuery("delete from rate_limit");
}

// Valid CPF (check digits included): the order forms reject the random-digit CPF of src/test/seed.ts.
export function validCpf(): string {
  const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const check = (base: number[]) => {
    const sum = base.reduce((acc, d, i) => acc + d * (base.length + 1 - i), 0);
    return (sum * 10) % 11 % 10;
  };
  digits.push(check(digits));
  digits.push(check(digits));
  return digits.join("").replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}
