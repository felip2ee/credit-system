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
import { confirmPublicScrAuthorization, getPublicScrAuthorization } from "@/lib/scr/queries";

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
const opportunityIds = [randomUUID(), randomUUID()];
const documentIds = [randomUUID(), randomUUID()];
const publicScrToken = randomUUID();
const refusedScrToken = randomUUID();

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
      await client.query(
        "insert into opportunities (id, crm_client_id, created_by) values ($1, $2, $3), ($4, $5, $3)",
        [
          opportunityIds[0],
          clientRows[0].id,
          identities.admin.userId,
          opportunityIds[1],
          clientRows[1].id,
        ],
      );
      await client.query(
        "insert into opportunity_documents (id, opportunity_id, doc_type, label) values ($1, $2, 'identity', 'Documento do cliente um'), ($3, $4, 'identity', 'Documento do cliente dois')",
        [documentIds[0], opportunityIds[0], documentIds[1], opportunityIds[1]],
      );
      await client.query(
        `insert into scr_authorizations
           (document, type, crm_client_id, status, channel, auth_code, public_token, consent_text, consent_name, consent_document)
         values
           ('11111111111', 'PF', $1, 'pending', 'internal', 'SECRET1', $2, 'Termo pÃºblico', 'Cliente um', '111.111.111-11'),
           ('22222222222', 'PF', $3, 'pending', 'internal', 'SECRET2', $4, 'Termo pÃºblico', 'Cliente dois', '222.222.222-22')`,
        [clientRows[0].id, publicScrToken, clientRows[1].id, refusedScrToken],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("limits client rows while administrators and consultants retain staff visibility", async () => {
    await expect(visibleClientNames(identities.admin)).resolves.toEqual([
      "RLS client one",
      "RLS client two",
    ]);
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

  it("keeps profiles deny-by-default outside the narrow auth lookup function", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from profiles where id = any($1::uuid[])",
      [Object.values(identities).map(({ userId }) => userId)],
    );

    expect(rows).toEqual([]);
  });

  it("lets a client upload metadata only to its own document slot", async () => {
    const changed = await withUserTransaction(identities.clientOne, (client) =>
      client.query(
        `update opportunity_documents
            set status = 'uploaded', file_name = 'identidade.pdf', file_path = 'ab/object', object_key = 'ab/object',
                sha256 = $2, byte_size = 12, file_size = 12, detected_mime = 'application/pdf',
                file_mime = 'application/pdf', scan_result = 'clean', uploaded_by = $3, uploaded_at = now(),
                scan_version = 'ClamAV test', rejection_reason = null
          where id = $1`,
        [documentIds[0], "a".repeat(64), identities.clientOne.userId],
      ),
    );
    expect(changed.rowCount).toBe(1);

    await expect(
      withUserTransaction(identities.clientOne, (client) =>
        client.query("update opportunity_documents set label = 'alterado' where id = $1", [documentIds[0]]),
      ),
    ).rejects.toThrow(/client document upload/i);

    const other = await withUserTransaction(identities.clientOne, (client) =>
      client.query("update opportunity_documents set status = 'uploaded' where id = $1", [documentIds[1]]),
    );
    expect(other.rowCount).toBe(0);
  });

  it("exposes and atomically confirms only a token-bound public SCR authorization", async () => {
    await expect(getPublicScrAuthorization(publicScrToken)).resolves.toMatchObject({
      status: "pending",
      type: "PF",
      consentText: "Termo pÃºblico",
      clientName: "Cliente um",
      document: "111.111.111-11",
    });
    await expect(getPublicScrAuthorization(randomUUID())).resolves.toBeNull();
    await expect(
      pool.query("select * from public.public_scr_authorization($1, $2)", [publicScrToken, "deps"]),
    ).resolves.toMatchObject({ rows: [] });

    await expect(
      confirmPublicScrAuthorization(publicScrToken, "WRONG", "authorize", null),
    ).resolves.toMatchObject({ status: "invalid_code" });
    await expect(getPublicScrAuthorization(publicScrToken)).resolves.toMatchObject({ status: "pending" });

    await expect(
      confirmPublicScrAuthorization(publicScrToken, "SECRET1", "authorize", "127.0.0.1"),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(
      confirmPublicScrAuthorization(publicScrToken, "SECRET1", "authorize", "127.0.0.1"),
    ).resolves.toMatchObject({ status: "already" });
    await expect(
      confirmPublicScrAuthorization(refusedScrToken, "", "refuse", null),
    ).resolves.toMatchObject({ status: "refused" });

    await expect(
      pool.query<{ rolbypassrls: boolean }>(
        "select rolbypassrls from pg_roles where rolname = 'auth_profile_lookup'",
      ),
    ).resolves.toMatchObject({ rows: [{ rolbypassrls: false }] });
    await expect(pool.query("select id from scr_authorizations")).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query("update scr_authorizations set status = 'authorized' where public_token = $1", [publicScrToken]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query(
        "insert into timeline_events (entity_type, entity_id, event_type, title) values ('crm_client', $1, 'scr.self_authorized', 'forged')",
        [clientRows[0].id],
      ),
    ).rejects.toThrow();
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
