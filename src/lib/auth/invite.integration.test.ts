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

import { createInvite, sendInviteEmail, type InviteInput } from "./invite";

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

// O gatilho de perfil só deixa um bureau_admin mudar is_active, até para o dono do banco.
async function deactivateProfile(id: string) {
  const client = await owner.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_role', 'bureau_admin', true)");
    await client.query("update profiles set is_active = false where id = $1", [id]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

describe("createInvite re-invite of a revoked client", () => {
  async function revokeClient(tenant: SeededTenant, withAccount: boolean) {
    if (withAccount) {
      await owner.query(
        "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, 'hash', now())",
        [randomUUID(), tenant.client.userId],
      );
    }
    await deactivateProfile(tenant.client.userId);
    const { rows } = await owner.query<{ email: string }>("select email from profiles where id = $1", [
      tenant.client.userId,
    ]);
    return rows[0].email;
  }

  it.each([true, false])("reactivates the inactive client profile (account: %s)", async (withAccount) => {
    const tenant = await seedTenant(owner, "invite");
    const email = await revokeClient(tenant, withAccount);

    const outcome = await asAdmin(
      tenant,
      inviteFor(tenant, { email, role: "client" }),
    );

    expect(outcome).toEqual({ ok: true, userId: tenant.client.userId, resent: true, reactivated: true });
    const { rows } = await owner.query("select is_active from profiles where id = $1", [tenant.client.userId]);
    expect(rows).toEqual([{ is_active: true }]);
  });

  it("does not reactivate an inactive staff profile", async () => {
    const tenant = await seedTenant(owner, "invite");
    await owner.query(
      "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, 'hash', now())",
      [randomUUID(), tenant.operator.userId],
    );
    await deactivateProfile(tenant.operator.userId);
    const { rows } = await owner.query<{ email: string }>("select email from profiles where id = $1", [
      tenant.operator.userId,
    ]);

    await expect(asAdmin(tenant, inviteFor(tenant, { email: rows[0].email }))).resolves.toEqual({
      ok: false,
      reason: "already_member",
    });
  });

  it("rejects the client e-mail of another bureau", async () => {
    const tenant = await seedTenant(owner, "invite");
    const other = await seedTenant(owner, "invite-other");
    const email = await revokeClient(other, true);

    await expect(
      asAdmin(tenant, inviteFor(tenant, { email, role: "client" })),
    ).resolves.toEqual({ ok: false, reason: "email_in_use" });
    const { rows } = await owner.query("select is_active from profiles where id = $1", [other.client.userId]);
    expect(rows).toEqual([{ is_active: false }]);
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
