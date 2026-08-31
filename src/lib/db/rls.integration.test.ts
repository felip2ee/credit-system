import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: "D:/credit-system/.data/documents",
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
  });
});

import { pool } from "./pool";
import { withUserTransaction, type DbIdentity } from "./transaction";

const identities = {
  admin: { userId: randomUUID(), role: "admin" },
  consultantOne: { userId: randomUUID(), role: "consultant" },
  consultantTwo: { userId: randomUUID(), role: "consultant" },
  clientOne: { userId: randomUUID(), role: "client" },
  clientTwo: { userId: randomUUID(), role: "client" },
} as const satisfies Record<string, DbIdentity>;

const clientRows = [
  { id: randomUUID(), name: "RLS client one", userId: identities.clientOne.userId },
  { id: randomUUID(), name: "RLS client two", userId: identities.clientTwo.userId },
];

async function visibleClientNames(identity: DbIdentity): Promise<string[]> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      "select name from crm_clients where id = any($1::uuid[]) order by name",
      [clientRows.map(({ id }) => id)],
    );
    return rows.map(({ name }) => name);
  });
}

async function context() {
  const { rows } = await pool.query<{
    userId: string | null;
    role: string | null;
    present: boolean;
  }>(
    'select app_user_id() as "userId", app_user_role() as role, app_context_present() as present',
  );
  return rows[0];
}

describe.sequential("transaction-scoped RLS identity", () => {
  beforeAll(async () => {
    await withUserTransaction(identities.admin, async (client) => {
      await client.query(
        'insert into "user" (id, name, email) values ($1, $2, $3), ($4, $5, $6), ($7, $8, $9), ($10, $11, $12), ($13, $14, $15)',
        [
          identities.admin.userId,
          "RLS admin",
          `${identities.admin.userId}@example.test`,
          identities.consultantOne.userId,
          "RLS consultant one",
          `${identities.consultantOne.userId}@example.test`,
          identities.consultantTwo.userId,
          "RLS consultant two",
          `${identities.consultantTwo.userId}@example.test`,
          identities.clientOne.userId,
          "RLS client one",
          `${identities.clientOne.userId}@example.test`,
          identities.clientTwo.userId,
          "RLS client two",
          `${identities.clientTwo.userId}@example.test`,
        ],
      );
      await client.query(
        "insert into profiles (id, auth_user_id, full_name, email, role) values ($1, $1, $2, $3, 'admin'), ($4, $4, $5, $6, 'consultant'), ($7, $7, $8, $9, 'consultant'), ($10, $10, $11, $12, 'client'), ($13, $13, $14, $15, 'client')",
        [
          identities.admin.userId,
          "RLS admin",
          `${identities.admin.userId}@example.test`,
          identities.consultantOne.userId,
          "RLS consultant one",
          `${identities.consultantOne.userId}@example.test`,
          identities.consultantTwo.userId,
          "RLS consultant two",
          `${identities.consultantTwo.userId}@example.test`,
          identities.clientOne.userId,
          "RLS client one",
          `${identities.clientOne.userId}@example.test`,
          identities.clientTwo.userId,
          "RLS client two",
          `${identities.clientTwo.userId}@example.test`,
        ],
      );
      await client.query(
        "insert into crm_clients (id, type, name, user_id, created_by) values ($1, 'PF', $2, $3, $4), ($5, 'PF', $6, $7, $4)",
        [
          clientRows[0].id,
          clientRows[0].name,
          clientRows[0].userId,
          identities.admin.userId,
          clientRows[1].id,
          clientRows[1].name,
          clientRows[1].userId,
        ],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("limits client rows while both consultants retain staff visibility", async () => {
    await expect(visibleClientNames(identities.clientOne)).resolves.toEqual([
      "RLS client one",
    ]);
    await expect(visibleClientNames(identities.clientTwo)).resolves.toEqual([
      "RLS client two",
    ]);
    await expect(visibleClientNames(identities.consultantOne)).resolves.toEqual([
      "RLS client one",
      "RLS client two",
    ]);
    await expect(visibleClientNames(identities.consultantTwo)).resolves.toEqual([
      "RLS client one",
      "RLS client two",
    ]);
  });

  it("clears the sole pooled connection after commit, rollback, and callback errors", async () => {
    const committedBackend = await withUserTransaction(
      identities.clientOne,
      async (client) => {
        const { rows } = await client.query<{ backend: number }>(
          "select pg_backend_pid() as backend",
        );
        return rows[0].backend;
      },
    );

    expect(await context()).toEqual({ userId: null, role: null, present: false });

    await expect(
      withUserTransaction(identities.clientTwo, async (client) => {
        await client.query("select 1 / 0");
      }),
    ).rejects.toThrow("division by zero");

    expect(await context()).toEqual({ userId: null, role: null, present: false });

    await expect(
      withUserTransaction(identities.clientTwo, async (client) => {
        await client.query("select 1");
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(await context()).toEqual({ userId: null, role: null, present: false });

    const reusedBackend = await withUserTransaction(
      identities.consultantOne,
      async (client) => {
        const { rows } = await client.query<{ backend: number }>(
          "select pg_backend_pid() as backend",
        );
        return rows[0].backend;
      },
    );

    expect(reusedBackend).toBe(committedBackend);
    expect(await context()).toEqual({ userId: null, role: null, present: false });
  });
});
