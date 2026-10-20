import { randomUUID } from "node:crypto";

import { verifyPassword } from "better-auth/crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

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

import pg from "pg";

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

import { ensureSuperadmin } from "./bootstrap";

const owner = new pg.Pool({ connectionString: TEST_DATABASE_OWNER_URL });
const created: string[] = [];
const password = "superadmin-password-1";

function freshEmail() {
  const email = `super-${randomUUID()}@example.test`;
  created.push(email);
  return email;
}

async function rowsFor(email: string) {
  const { rows } = await owner.query<{
    id: string;
    role: string;
    bureauId: string | null;
    password: string;
  }>(
    `select u.id, p.role::text as role, p.bureau_id as "bureauId", a.password
       from "user" u
       join profiles p on p.auth_user_id = u.id
       join account a on a.user_id = u.id and a.provider_id = 'credential'
      where lower(u.email) = lower($1)`,
    [email],
  );
  return rows;
}

afterAll(async () => {
  try {
    for (const email of created) {
      const { rows } = await owner.query<{ id: string }>(
        `select id from "user" where lower(email) = lower($1)`,
        [email],
      );
      for (const { id } of rows) {
        await owner.query("delete from audit_logs where user_id = $1::uuid", [id]);
        await owner.query("delete from profiles where id = $1::uuid", [id]);
        await owner.query(`delete from "user" where id = $1`, [id]);
      }
    }
  } finally {
    try {
      await owner.end();
    } finally {
      await pool.end();
    }
  }
});

describe("ensureSuperadmin", () => {
  it("does nothing without SUPERADMIN_EMAIL", async () => {
    await expect(ensureSuperadmin({})).resolves.toBe("disabled");
  });

  it("creates a superadmin without a bureau, with a verifiable password and audit entry", async () => {
    const email = freshEmail();
    await expect(
      ensureSuperadmin({ SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: password }),
    ).resolves.toBe("created");

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("superadmin");
    expect(rows[0].bureauId).toBeNull();
    expect(await verifyPassword({ hash: rows[0].password, password })).toBe(true);

    const audit = await owner.query(
      "select bureau_id, support_session_id from audit_logs where user_id = $1::uuid and action = 'superadmin.bootstrap'",
      [rows[0].id],
    );
    expect(audit.rows).toEqual([{ bureau_id: null, support_session_id: null }]);
  });

  it("never overwrites an existing user, matching email case-insensitively", async () => {
    const email = freshEmail();
    await ensureSuperadmin({ SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: password });
    const before = await rowsFor(email);

    await expect(
      ensureSuperadmin({
        SUPERADMIN_EMAIL: `  ${email.toUpperCase()}  `,
        SUPERADMIN_PASSWORD: "a-different-password-123",
      }),
    ).resolves.toBe("exists");

    const after = await rowsFor(email);
    expect(after).toEqual(before);
  });

  it("creates exactly one user when two instances race", async () => {
    const email = freshEmail();
    const env = { SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: password };
    const results = await Promise.all([ensureSuperadmin(env), ensureSuperadmin(env)]);
    expect(results.sort()).toEqual(["created", "exists"]);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it("rejects a missing or weak password and an invalid email", async () => {
    await expect(ensureSuperadmin({ SUPERADMIN_EMAIL: freshEmail() })).rejects.toThrow(
      /SUPERADMIN_PASSWORD is required/,
    );
    await expect(
      ensureSuperadmin({ SUPERADMIN_EMAIL: freshEmail(), SUPERADMIN_PASSWORD: "short" }),
    ).rejects.toThrow(/12 and 128/);
    await expect(
      ensureSuperadmin({ SUPERADMIN_EMAIL: "not-an-email", SUPERADMIN_PASSWORD: password }),
    ).rejects.toThrow(/valid email/);
  });
});
