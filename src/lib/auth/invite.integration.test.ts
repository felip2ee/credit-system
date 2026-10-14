import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const requestPasswordReset = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgres://app_runtime:test@localhost:54329/credit_system",
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

vi.mock("next/headers", () => ({
  headers: () => {
    throw new Error("no request scope");
  },
}));
vi.mock("./server", () => ({ auth: { api: { requestPasswordReset } } }));

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant, type SeededTenant } from "@/test/seed";

import { createInvite, inviteInputSchema, sendInviteEmail, type InviteInput } from "./invite";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

afterAll(async () => {
  try {
    await owner.end();
  } finally {
    await pool.end();
  }
});

beforeEach(() => {
  requestPasswordReset.mockReset();
});

function inviteFor(tenant: SeededTenant, overrides: Partial<InviteInput> = {}): InviteInput {
  return {
    email: `invite-${randomUUID()}@example.test`,
    fullName: "Pessoa Convidada",
    role: "operator",
    bureauId: tenant.bureau.id,
    ...overrides,
  };
}

function asAdmin(tenant: SeededTenant, input: InviteInput) {
  const actor: DbIdentity = tenant.bureauAdmin;
  return withUserTransaction(actor, (client) => createInvite(client, actor.userId, input));
}

async function counts(email: string) {
  const { rows } = await owner.query<{ users: number; profiles: number; audits: number }>(
    `select (select count(*) from "user" where lower(email) = $1)::int as users,
            (select count(*) from profiles where email = $1)::int as profiles,
            (select count(*) from audit_logs where action = 'user.invite' and metadata->>'email' = $1)::int as audits`,
    [email],
  );
  return rows[0];
}

describe("createInvite", () => {
  it("creates user, profile and audit event for a new e-mail", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);

    const outcome = await asAdmin(tenant, input);

    expect(outcome).toMatchObject({ ok: true, resent: false });
    expect(await counts(input.email)).toEqual({ users: 1, profiles: 1, audits: 1 });
    const { rows } = await owner.query(
      "select role::text, bureau_id, is_active from profiles where email = $1",
      [input.email],
    );
    expect(rows).toEqual([{ role: "operator", bureau_id: tenant.bureau.id, is_active: true }]);
    const audit = await owner.query(
      "select bureau_id, user_id from audit_logs where action = 'user.invite' and metadata->>'email' = $1",
      [input.email],
    );
    expect(audit.rows).toEqual([{ bureau_id: tenant.bureau.id, user_id: tenant.bureauAdmin.userId }]);
  });

  it("resends for the same e-mail, bureau and role while the account is not activated", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);
    const first = await asAdmin(tenant, input);

    const second = await asAdmin(tenant, input);

    expect(first).toMatchObject({ ok: true, resent: false });
    expect(second).toEqual({ ok: true, userId: (first as { userId: string }).userId, resent: true });
    expect(await counts(input.email)).toEqual({ users: 1, profiles: 1, audits: 1 });
  });

  it("returns already_member when the invited user already has an account", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);
    const first = await asAdmin(tenant, input);
    const userId = (first as { userId: string }).userId;
    await owner.query(
      "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, 'hash', now())",
      [randomUUID(), userId],
    );

    await expect(asAdmin(tenant, input)).resolves.toEqual({ ok: false, reason: "already_member" });
  });

  it("returns email_in_use for a profile with another role", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);
    await asAdmin(tenant, input);

    await expect(asAdmin(tenant, { ...input, role: "bureau_admin" })).resolves.toEqual({
      ok: false,
      reason: "email_in_use",
    });
  });

  it("returns email_in_use for a profile of another bureau", async () => {
    const tenant = await seedTenant(owner, "invite");
    const other = await seedTenant(owner, "invite-other");
    const input = inviteFor(tenant);
    await asAdmin(tenant, input);

    await expect(asAdmin(other, { ...input, bureauId: other.bureau.id })).resolves.toEqual({
      ok: false,
      reason: "email_in_use",
    });
    expect(await counts(input.email)).toEqual({ users: 1, profiles: 1, audits: 1 });
  });

  it("returns email_in_use for a user without a profile", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);
    await owner.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
      randomUUID(),
      "Sem perfil",
      input.email,
    ]);

    await expect(asAdmin(tenant, input)).resolves.toEqual({ ok: false, reason: "email_in_use" });
  });

  it("matches the e-mail case-insensitively", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);
    await asAdmin(tenant, input);

    await expect(asAdmin(tenant, { ...input, email: input.email.toUpperCase() })).resolves.toMatchObject({
      ok: true,
      resent: true,
    });
  });

  it("rolls user, profile and audit event back together when a later step fails", async () => {
    const tenant = await seedTenant(owner, "invite");
    const input = inviteFor(tenant);
    const failure = new Error("after insert");
    const actor: DbIdentity = tenant.bureauAdmin;

    await expect(
      withUserTransaction(actor, async (client) => {
        await createInvite(client, actor.userId, input);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await counts(input.email)).toEqual({ users: 0, profiles: 0, audits: 0 });
  });
});

describe("inviteInputSchema", () => {
  const valid = {
    email: "  Pessoa@Example.TEST ",
    fullName: "  Pessoa Convidada ",
    role: "operator",
    bureauId: "66666666-6666-4666-8666-666666666666",
  };

  it("normalizes e-mail and name", () => {
    expect(inviteInputSchema.parse(valid)).toEqual({
      ...valid,
      email: "pessoa@example.test",
      fullName: "Pessoa Convidada",
    });
  });

  it.each([
    ["bureauId is not a uuid", { bureauId: "not-a-uuid" }],
    ["name is too short", { fullName: "ab" }],
    ["e-mail is invalid", { email: "nope" }],
    ["role is superadmin", { role: "superadmin" }],
  ])("fails when %s", (_name, patch) => {
    expect(inviteInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("sendInviteEmail", () => {
  it("requests a password reset and returns true", async () => {
    requestPasswordReset.mockResolvedValue({ status: true });

    await expect(sendInviteEmail("a@example.test")).resolves.toBe(true);
    expect(requestPasswordReset).toHaveBeenCalledWith({
      body: { email: "a@example.test", redirectTo: "http://localhost:3000/update-password" },
    });
  });

  it("returns false when the send fails", async () => {
    requestPasswordReset.mockRejectedValue(new Error("smtp down"));

    await expect(sendInviteEmail("a@example.test")).resolves.toBe(false);
  });
});
