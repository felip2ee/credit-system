import { afterAll, describe, expect, it, vi } from "vitest";

// One pooled connection: the next pool.query reuses the connection the transaction just used.
vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgres://app_runtime:test@localhost:54329/credit_system",
    PG_POOL_MAX: "1",
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

import { pool } from "./pool";
import { withUserTransaction } from "./transaction";

const identity = {
  userId: "44444444-4444-4444-8444-444444444444",
  role: "operator",
  bureauId: "55555555-5555-4555-8555-555555555555",
  supportSessionId: null,
} as const;

const contextRead = `select nullif(current_setting('app.user_id', true), '') as "userId",
  nullif(current_setting('app.user_role', true), '') as role,
  nullif(current_setting('app.bureau_id', true), '') as "bureauId",
  nullif(current_setting('app.support_session_id', true), '') as "supportSessionId"`;

const empty = { userId: null, role: null, bureauId: null, supportSessionId: null };

afterAll(() => pool.end());

describe("withUserTransaction context", () => {
  it("exposes the identity inside the transaction", async () => {
    const inside = await withUserTransaction(identity, async (client) => (await client.query(contextRead)).rows[0]);

    expect(inside).toEqual({
      userId: identity.userId,
      role: identity.role,
      bureauId: identity.bureauId,
      supportSessionId: null,
    });
  });

  it("clears the sole pooled connection after commit", async () => {
    await withUserTransaction(identity, async () => undefined);

    expect((await pool.query(contextRead)).rows[0]).toEqual(empty);
  });

  it("clears the sole pooled connection after rollback", async () => {
    await expect(
      withUserTransaction(identity, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await pool.query(contextRead)).rows[0]).toEqual(empty);
  });
});
