// Integration test for executeConsultation — proves the atomic persist flow
// against a real Postgres (pool max:1, RLS-scoped transactions).
//
// DB execution is deferred to the Task 15 release gate (Docker daemon not
// available in this environment) — consistent with the Task 3 integration-gate
// ruling. No skips, no mocks faking a pass: the DEPS client is the only seam,
// stubbed with fixed raw responses; everything else hits the database.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgres://app_runtime:test@localhost:54329/credit_system_test",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: "/tmp/reino-test-documents",
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
  });
});

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant, type SeededTenant } from "@/test/seed";
import type { DepsRawConsult } from "@/types/deps";
import {
  canonicalJson,
  executeConsultation,
  payloadSha256,
} from "./service";

import pfCurrent from "../deps/__fixtures__/pf-current.json";
import pjCurrent from "../deps/__fixtures__/pj-current.json";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });
let tenant: SeededTenant;
let staff: DbIdentity;

// A valid PF body straight from the adapter fixture (array-wrapped envelope).
const validBody: unknown = pfCurrent;
// Identity block present but wrong-typed name -> real data that fails schema
// validation -> payload_incompatible.
const incompatibleBody: unknown = {
  mix: { pessoa: { data: { cpf: "39053344705", nome: 12345 } } },
};
// No identity block at all -> DEPS "documento sem dados / SCR pendente" -> no_data.
const noDataBody: unknown = { mix: { score: { data: { valor: 700 } } } };

const rawOf = (body: unknown): DepsRawConsult => ({
  httpStatus: 200,
  product: DEPS_PRODUCT_PF,
  body,
  receivedAt: "2026-08-31T00:00:00.000Z",
});

// One consultation row per test, all owned by `staff`.
const consultationIds = {
  valid: randomUUID(),
  incompatible: randomUUID(),
  noData: randomUUID(),
  rollback: randomUUID(),
  idempotent: randomUUID(),
  network: randomUUID(),
};

// Cada consulta pertence a um Dossiê do Titular do seed.
async function seedConsultation(
  id: string,
  type: "PF" | "PJ" = "PF",
  holderId = tenant.holder.id,
  document = tenant.holder.document.replace(/\D/g, ""),
): Promise<void> {
  const dossier = await owner.query<{ id: string }>(
    `insert into dossiers (bureau_id, kind, holder_id, product, created_by)
     values ($1, $2::dossier_kind, $3, $4, $5) returning id`,
    [tenant.bureau.id, type, holderId, type === "PF" ? DEPS_PRODUCT_PF : DEPS_PRODUCT_PJ, tenant.bureauAdmin.userId],
  );
  await owner.query(
    `insert into consultations (id, bureau_id, type, document, holder_id, dossier_id, created_by, status)
     values ($1, $2, $3::query_type, $4, $5, $6, $7, 'processing')`,
    [id, tenant.bureau.id, type, document, holderId, dossier.rows[0].id, staff.userId],
  );
}

async function payloadRows(consultationId: string) {
  return withUserTransaction(staff, async (client) => {
    const { rows } = await client.query<{
      payload_sha256: string;
      validation_status: string;
      validation_errors: unknown[];
    }>(
      `select payload_sha256, validation_status, validation_errors
         from bureau_payloads where consultation_id = $1
        order by received_at`,
      [consultationId],
    );
    return rows;
  });
}

async function consultationStatus(id: string): Promise<string> {
  return withUserTransaction(staff, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      "select status from consultations where id = $1",
      [id],
    );
    return rows[0].status;
  });
}

async function resultRow(consultationId: string) {
  return withUserTransaction(staff, async (client) => {
    const { rows } = await client.query(
      `select document, person_name, score, risk_level, adapter_version
         from bureau_results where consultation_id = $1`,
      [consultationId],
    );
    return rows[0] ?? null;
  });
}

describe.sequential("executeConsultation", () => {
  beforeAll(async () => {
    tenant = await seedTenant(owner, "Persist");
    staff = tenant.operator;
    for (const id of Object.values(consultationIds)) {
      await seedConsultation(id);
    }
  });

  afterAll(async () => {
    try {
      await owner.end();
    } finally {
      await pool.end();
    }
  });

  it("hashes a deterministic UTF-8 serialization regardless of key order", () => {
    const a = { b: 1, a: { y: [1, 2], x: 3 }, c: undefined };
    const b = { c: undefined, a: { x: 3, y: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadSha256(a)).toBe(payloadSha256(b));
    expect(payloadSha256(validBody)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the raw payload, then commits canonical result + completed status together", async () => {
    const id = consultationIds.valid;
    const out = await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PF",
      consult: async () => rawOf(validBody),
    });

    expect(out.status).toBe("completed");

    const payloads = await payloadRows(id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload_sha256).toBe(payloadSha256(validBody));
    expect(payloads[0].validation_status).toBe("valid");

    expect(await consultationStatus(id)).toBe("completed");

    const row = await resultRow(id);
    expect(row).toMatchObject({
      document: "39053344705",
      person_name: "Fulano De Tal Anonimo",
      score: 742,
      adapter_version: 1,
    });
  });

  it("marks an incompatible payload with JSON-path errors and no fabricated result", async () => {
    const id = consultationIds.incompatible;
    const out = await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PF",
      consult: async () => rawOf(incompatibleBody),
    });

    expect(out.status).toBe("payload_incompatible");

    const payloads = await payloadRows(id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].validation_status).toBe("incompatible");
    expect(payloads[0].validation_errors.length).toBeGreaterThan(0);
    // Paths only — no payload values leaked into the error blob.
    expect(JSON.stringify(payloads[0].validation_errors)).not.toContain("12345");

    expect(await consultationStatus(id)).toBe("payload_incompatible");
    expect(await resultRow(id)).toBeNull();
  });

  it("keeps a no-identity response as recoverable: payload stored 'pending', status untouched", async () => {
    const id = consultationIds.noData;
    const out = await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PF",
      consult: async () => rawOf(noDataBody),
    });

    expect(out.status).toBe("no_data");

    const payloads = await payloadRows(id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].validation_status).toBe("pending");

    // Consultation status left for the caller's SCR-pending flow.
    expect(await consultationStatus(id)).toBe("processing");
    expect(await resultRow(id)).toBeNull();
  });

  it("rolls back the payload insert when a later write in the same transaction fails", async () => {
    const id = consultationIds.rollback;
    // First response commits a bureau_results row (consultation_id is its PK).
    await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PF",
      consult: async () => rawOf(validBody),
    });

    // A second, DIFFERENT response: payload insert succeeds, but the
    // bureau_results insert collides on the primary key -> whole tx rolls back.
    const mutated = structuredClone(pfCurrent) as unknown as Array<{
      mix: Record<string, unknown>;
    }>;
    mutated[0].mix.historicoConsultaId = "00000000-0000-0000-0000-0000000000ff";

    await expect(
      executeConsultation({
        identity: staff,
        consultationId: id,
        entityKind: "PF",
        consult: async () => rawOf(mutated),
      }),
    ).rejects.toThrow();

    // Only the first payload survived; status unchanged.
    const payloads = await payloadRows(id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload_sha256).toBe(payloadSha256(validBody));
    expect(await consultationStatus(id)).toBe("completed");
  });

  it("does not duplicate on a retry with the same payload; re-derives the outcome", async () => {
    const id = consultationIds.idempotent;
    const first = await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PF",
      consult: async () => rawOf(validBody),
    });
    expect(first.status).toBe("completed");

    const second = await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PF",
      consult: async () => rawOf(validBody),
    });
    expect(second.status).toBe("completed");

    expect(await payloadRows(id)).toHaveLength(1);
  });

  it("propagates a pre-response network failure without writing a payload row", async () => {
    const id = consultationIds.network;
    await expect(
      executeConsultation({
        identity: staff,
        consultationId: id,
        entityKind: "PF",
        consult: async () => {
          throw new Error("network unreachable");
        },
      }),
    ).rejects.toThrow("network unreachable");

    expect(await payloadRows(id)).toHaveLength(0);
    expect(await consultationStatus(id)).toBe("processing");
  });

  it("cria Sociedades source 'deps' a partir do quadro societário da consulta PJ, sem novas consultas", async () => {
    const cnpj = String(Date.now()).padStart(14, "7").slice(-14);
    const company = await owner.query<{ id: string }>(
      `insert into holders (bureau_id, type, name, document, created_by)
       values ($1, 'PJ', 'Empresa Fixture', $2, $3) returning id`,
      [tenant.bureau.id, cnpj, tenant.bureauAdmin.userId],
    );
    const id = randomUUID();
    await seedConsultation(id, "PJ", company.rows[0].id, cnpj);
    const before = await owner.query("select 1 from consultations where bureau_id = $1", [tenant.bureau.id]);

    const out = await executeConsultation({
      identity: staff,
      consultationId: id,
      entityKind: "PJ",
      consult: async () => ({ ...rawOf(pjCurrent), product: DEPS_PRODUCT_PJ }),
    });
    expect(out.status).toBe("completed");

    const links = await owner.query<{ source: string; percentage: string; document_digits: string }>(
      `select p.source, p.percentage, h.document_digits
         from holder_partnerships p join holders h on h.id = p.partner_id
        where p.company_id = $1 order by h.document_digits`,
      [company.rows[0].id],
    );
    expect(links.rows).toEqual([
      { source: "deps", percentage: "60.00", document_digits: "39053344705" },
      { source: "deps", percentage: "40.00", document_digits: "52998224725" },
    ]);
    const after = await owner.query("select 1 from consultations where bureau_id = $1", [tenant.bureau.id]);
    expect(after.rowCount).toBe(before.rowCount);

    const dossier = await owner.query<{ status: string }>(
      "select d.status::text from dossiers d join consultations c on c.dossier_id = d.id where c.id = $1",
      [id],
    );
    expect(dossier.rows[0].status).toBe("completed");
  });
});
