// Integration test for the CRM / settings / audit / dashboard data access
// migrated in Task 9 — one assertion per active mutation/read family, all
// against a real Postgres (pool max:1, RLS-scoped transactions).
//
// DB execution is deferred to the Task 15 release gate (no Docker daemon in
// this environment) — consistent with the Task 3/7 integration-gate ruling.
// No skips, no mocks faking a pass: everything here hits the database.

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

// next/headers is unavailable outside a request — audit correlation id falls
// back to a uuid, which is all this test needs.
vi.mock("next/headers", () => ({
  headers: () => {
    throw new Error("no request scope");
  },
}));

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { writeAuditEvent } from "@/lib/audit/write";
import {
  addClientNote,
  createClientRecord,
  getClientDetail,
  linkPartner,
  listClients,
  updateClientRecord,
  updateClientStatus,
} from "@/lib/clients/queries";
import {
  deleteSettings,
  readSetting,
  upsertSettings,
} from "@/lib/settings/queries";
import { getDashboardMetrics } from "@/lib/dashboard/queries";
import type { ClientInput } from "@/lib/validators/client";

const admin: DbIdentity = { userId: randomUUID(), role: "admin" };

const baseClient = (over: Partial<ClientInput> = {}): ClientInput =>
  ({
    type: "PF",
    name: "Cliente Integração",
    document: "39053344705",
    email: null,
    phone: null,
    address: null,
    address_number: null,
    address_complement: null,
    neighborhood: null,
    city: "Palmas",
    state: "TO",
    zip_code: null,
    status: "prospect",
    notes: null,
    ...over,
  }) as ClientInput;

describe.sequential("Task 9 domain data access", () => {
  beforeAll(async () => {
    await withUserTransaction(admin, async (client) => {
      await client.query(
        'insert into "user" (id, name, email) values ($1, $2, $3)',
        [admin.userId, "Domain admin", `${admin.userId}@example.test`],
      );
      await client.query(
        `insert into profiles (id, auth_user_id, full_name, email, role)
         values ($1, $1, $2, $3, 'admin')`,
        [admin.userId, "Domain admin", `${admin.userId}@example.test`],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("createClientRecord persists the client, its primary document and a timeline event", async () => {
    const result = await createClientRecord(admin, baseClient());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = await getClientDetail(admin, result.id);
    expect(detail?.client.name).toBe("Cliente Integração");
    expect(detail?.events.some((e) => e.event_type === "client.created")).toBe(
      true,
    );
  });

  it("createClientRecord rejects a duplicate document", async () => {
    await createClientRecord(admin, baseClient({ document: "11144477735" }));
    const dup = await createClientRecord(
      admin,
      baseClient({ document: "11144477735", name: "Outro" }),
    );
    expect(dup).toEqual({ ok: false, reason: "duplicate_document" });
  });

  it("updateClientRecord and updateClientStatus mutate the row", async () => {
    const created = await createClientRecord(
      admin,
      baseClient({ document: "22255588846" }),
    );
    if (!created.ok) throw new Error("setup failed");

    await updateClientRecord(
      admin,
      created.id,
      baseClient({ document: "22255588846", name: "Nome Novo", notes: "obs" }),
    );
    await updateClientStatus(admin, created.id, "active");

    const detail = await getClientDetail(admin, created.id);
    expect(detail?.client.name).toBe("Nome Novo");
    expect(detail?.client.status).toBe("active");
  });

  it("addClientNote writes a note and a timeline event in one transaction", async () => {
    const created = await createClientRecord(
      admin,
      baseClient({ document: "33366699957" }),
    );
    if (!created.ok) throw new Error("setup failed");

    await addClientNote(admin, created.id, "primeira anotação");
    const detail = await getClientDetail(admin, created.id);
    expect(detail?.events.some((e) => e.event_type === "note.added")).toBe(true);
  });

  it("linkPartner attaches a partner and refuses a duplicate link", async () => {
    const pj = await createClientRecord(
      admin,
      baseClient({ type: "PJ", name: "Empresa X", document: "11222333000181" }),
    );
    if (!pj.ok) throw new Error("setup failed");

    const first = await linkPartner(admin, pj.id, {
      document: "98765432100",
      name: "Sócio Um",
      percentage: 50,
      role: "socio",
    });
    expect(first.ok).toBe(true);

    const again = await linkPartner(admin, pj.id, {
      document: "98765432100",
      name: "Sócio Um",
      percentage: 50,
      role: "socio",
    });
    expect(again).toEqual({ ok: false, reason: "already_linked" });
  });

  it("listClients filters by type and text", async () => {
    const rows = await listClients(admin, { type: "PJ", q: "Empresa" });
    expect(rows.every((r) => r.type === "PJ")).toBe(true);
    expect(rows.some((r) => r.name.includes("Empresa"))).toBe(true);
  });

  it("upsertSettings / readSetting / deleteSettings round-trip a value", async () => {
    await upsertSettings(
      admin,
      [{ key: "default_commission_rate", value: 7.5 }],
      "settings.commission_update",
    );
    expect(await readSetting(admin, "default_commission_rate")).toBe(7.5);

    await deleteSettings(
      admin,
      ["default_commission_rate"],
      "settings.commission_reset",
    );
    expect(await readSetting(admin, "default_commission_rate")).toBeNull();
  });

  it("writeAuditEvent appends a redacted, append-only row", async () => {
    await withUserTransaction(admin, (client) =>
      writeAuditEvent(client, {
        actorId: admin.userId,
        action: "client.create",
        targetTable: "crm_clients",
        targetId: admin.userId,
        metadata: { document: "39053344705", name: "keep" },
      }),
    );

    const { rows } = await withUserTransaction(admin, (client) =>
      client.query<{ action: string; metadata: Record<string, unknown> }>(
        "select action, metadata from audit_logs where user_id = $1 order by created_at desc limit 1",
        [admin.userId],
      ),
    );
    expect(rows[0].action).toBe("client.create");
    expect(JSON.stringify(rows[0].metadata)).not.toContain("39053344705");
    expect(rows[0].metadata.name).toBe("keep");

    // Append-only: runtime role has no update/delete grant on audit_logs.
    await expect(
      withUserTransaction(admin, (client) =>
        client.query("delete from audit_logs where user_id = $1", [admin.userId]),
      ),
    ).rejects.toThrow();
  });

  it("getDashboardMetrics counts seeded rows", async () => {
    const now = new Date();
    const metrics = await getDashboardMetrics(admin, {
      startToday: new Date(now.getTime() - 86_400_000).toISOString(),
      startMonth: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
      start6mo: new Date(now.getTime() - 180 * 86_400_000).toISOString(),
    });
    expect(metrics.counts.clients).toBeGreaterThan(0);
    expect(Array.isArray(metrics.opportunities)).toBe(true);
  });
});
