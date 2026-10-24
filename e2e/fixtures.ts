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
  product: "dossie_empresarial",
  salePrice: "20.00",
  salePricePerPartner: "5.00",
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

// Ticks until every member of the order (company, subject and partners) has its SCR request issued,
// then answers each one on the public page like its holder would.
export async function authorizeScr(page: Page, request: APIRequestContext, dossierId: string): Promise<void> {
  const scrsOf = () =>
    dbQuery<{ auth_code: string | null; public_token: string | null }>(
      `select s.auth_code, s.public_token from consultations c
         left join scr_authorizations s on s.id = c.scr_authorization_id
        where c.dossier_id = $1`,
      [dossierId],
    );
  await expect
    .poll(async () => {
      await runTick(request);
      const scrs = await scrsOf();
      return scrs.length > 0 && scrs.every((s) => s.auth_code !== null);
    }, { message: "tick issues the SCR requests", timeout: TICK_POLL_TIMEOUT_MS, intervals: [1_000] })
    .toBe(true);
  for (const scr of await scrsOf()) {
    await page.goto(`/autorizacao-scr/${scr.public_token}`);
    await page.getByLabel("Código de confirmação").fill(scr.auth_code ?? "");
    await page.getByRole("button", { name: "Autorizar" }).click();
    // The action revalidates the page, so the form may be replaced by the "already granted" notice.
    await expect(page.getByText(/Autorização concedida com sucesso|Esta autorização já foi concedida/)).toBeVisible();
  }
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

// Valid CNPJ (check digits included) for the company forms.
export function validCnpj(): string {
  const digits = [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1];
  const check = (base: number[]) => {
    const weights = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = base.reduce((acc, d, i) => acc + d * weights[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  digits.push(check(digits));
  digits.push(check(digits));
  return digits.join("").replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3.$4-$5");
}
