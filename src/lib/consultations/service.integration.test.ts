// Integration test for executeConsultation — proves the atomic persist flow
// against a real Postgres (pool max:1, RLS-scoped transactions).
//
// DB execution is deferred to the Task 15 release gate (Docker daemon not
// available in this environment) — consistent with the Task 3 integration-gate
// ruling. No skips, no mocks faking a pass: the DEPS client is the only seam,
// stubbed with fixed raw responses; everything else hits the database.

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

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { DepsRawConsult } from "@/types/deps";
import {
  canonicalJson,
  executeConsultation,
  payloadSha256,
} from "./service";

import pfCurrent from "../deps/__fixtures__/pf-current.json";

const staff: DbIdentity = { userId: randomUUID(), role: "consultant" };

// A valid PF body straight from the adapter fixture (array-wrapped envelope).
const validBody: unknown = pfCurrent;
// No pessoa / empresa identity block -> adapter fails closed.
const incompatibleBody: unknown = { mix: { score: { data: { valor: 700 } } } };

const rawOf = (body: unknown): DepsRawConsult => ({
  httpStatus: 200,
  product: "Smart PF 002",
  body,
  receivedAt: "2026-08-31T00:00:00.000Z",
});

// One consultation row per test, all owned by `staff`.
const consultationIds = {
  valid: randomUUID(),
  incompatible: randomUUID(),
  rollback: randomUUID(),
  idempotent: randomUUID(),
  network: randomUUID(),
};

async function seedConsultation(
  client: Parameters<Parameters<typeof withUserTransaction>[1]>[0],
  id: string,
): Promise<void> {
  await client.query(
    `insert into consultations (id, type, document, created_by, status)
     values ($1, 'PF', '39053344705', $2, 'processing')`,
    [id, staff.userId],
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
    await withUserTransaction(staff, async (client) => {
      await client.query(
        'insert into "user" (id, name, email) values ($1, $2, $3)',
        [staff.userId, "Persist staff", `${staff.userId}@example.test`],
      );
      await client.query(
        `insert into profiles (id, auth_user_id, full_name, email, role)
         values ($1, $1, $2, $3, 'consultant')`,
        [staff.userId, "Persist staff", `${staff.userId}@example.test`],
      );
      for (const id of Object.values(consultationIds)) {
        await seedConsultation(client, id);
      }
    });
  });

  afterAll(async () => {
    await pool.end();
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
    expect(JSON.stringify(payloads[0].validation_errors)).not.toContain("700");

    expect(await consultationStatus(id)).toBe("payload_incompatible");
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

  it("treats a retry with the same payload as an idempotent no-op", async () => {
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
    expect(second.status).toBe("idempotent");

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
});
