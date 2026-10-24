import { randomBytes } from "node:crypto";

import { Pool } from "pg";
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

import { getPublicBureau } from "@/lib/bureaus/public";
import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 1 });

afterAll(async () => {
  await owner.end();
  await pool.end();
});

describe("getPublicBureau", () => {
  it("returns name and slug for an active bureau", async () => {
    const suffix = randomBytes(4).toString("hex");
    const slug = `pub-${suffix}`;
    await owner.query("insert into bureaus (name, slug) values ($1, $2)", [
      `Pub ${suffix}`,
      slug,
    ]);
    await expect(getPublicBureau(slug)).resolves.toEqual({
      name: `Pub ${suffix}`,
      slug,
    });
  });

  it("getPublicBureau returns null for unknown and inactive", async () => {
    const suffix = randomBytes(4).toString("hex");
    const slug = `off-${suffix}`;
    await owner.query(
      "insert into bureaus (name, slug, status) values ($1, $2, 'inactive')",
      [`Off ${suffix}`, slug],
    );
    await expect(getPublicBureau(slug)).resolves.toBeNull();
    await expect(getPublicBureau(`nao-existe-${suffix}`)).resolves.toBeNull();
  });

  it.each(["AB", "a_b"])("returns null for invalid slug %j without querying", async (slug) => {
    const spy = vi.spyOn(pool, "query");
    await expect(getPublicBureau(slug)).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
