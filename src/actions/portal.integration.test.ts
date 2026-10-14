import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { current: null as unknown },
  requestPasswordReset: vi.fn(),
  revalidatePath: vi.fn(),
}));

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
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/server", () => ({ auth: { api: { requestPasswordReset: mocks.requestPasswordReset } } }));
vi.mock("@/lib/auth/session", () => ({ getRequiredSession: async () => mocks.session.current }));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { randomCpf, seedTenant, type SeededTenant } from "@/test/seed";

import { inviteHolderToPortal, revokeHolderPortalAccess } from "./portal";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

afterAll(async () => {
  try {
    await owner.end();
  } finally {
    await pool.end();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestPasswordReset.mockResolvedValue({ status: true });
});

function actAs(tenant: SeededTenant) {
  mocks.session.current = { ...tenant.bureauAdmin, supportSessionId: null };
}

async function emailOf(userId: string): Promise<string> {
  const { rows } = await owner.query<{ email: string }>("select email from profiles where id = $1", [userId]);
  return rows[0].email;
}

async function addAccount(userId: string) {
  await owner.query(
    "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, 'hash', now())",
    [randomUUID(), userId],
  );
}

async function profileState(userId: string) {
  const { rows } = await owner.query<{ is_active: boolean }>("select is_active from profiles where id = $1", [userId]);
  return rows[0]?.is_active;
}

async function linkedProfile(holderId: string) {
  const { rows } = await owner.query<{ client_profile_id: string | null }>(
    "select client_profile_id from holders where id = $1",
    [holderId],
  );
  return rows[0].client_profile_id;
}

async function unlinkedHolder(tenant: SeededTenant, email: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into holders (bureau_id, type, name, document, created_by, email)
     values ($1, 'PF', 'Titular Novo', $2, $3, $4) returning id`,
    [tenant.bureau.id, randomCpf(), tenant.bureauAdmin.userId, email],
  );
  return rows[0].id;
}

async function auditCount(holderId: string, action: string) {
  const { rows } = await owner.query<{ n: number }>(
    "select count(*)::int as n from audit_logs where action = $1 and record_id = $2",
    [action, holderId],
  );
  return rows[0].n;
}

describe.each([
  ["accepted", true],
  ["never accepted", false],
])("revoke then re-invite (%s invite)", (_name, accepted) => {
  it("reactivates the profile, relinks the holder and sends a fresh link", async () => {
    const tenant = await seedTenant(owner, "portal");
    actAs(tenant);
    const email = await emailOf(tenant.client.userId);
    await owner.query("update holders set email = $2 where id = $1", [tenant.holder.id, email]);
    if (accepted) await addAccount(tenant.client.userId);

    await expect(revokeHolderPortalAccess(tenant.holder.id)).resolves.toEqual({ error: null });
    expect(await profileState(tenant.client.userId)).toBe(false);
    expect(await linkedProfile(tenant.holder.id)).toBeNull();

    await expect(inviteHolderToPortal(tenant.holder.id)).resolves.toEqual({ error: null, id: tenant.client.userId });

    expect(await profileState(tenant.client.userId)).toBe(true);
    expect(await linkedProfile(tenant.holder.id)).toBe(tenant.client.userId);
    expect(await auditCount(tenant.holder.id, "portal.reinvite")).toBe(1);
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith({
      body: { email, redirectTo: "http://localhost:3000/update-password" },
    });
  });
});

describe("inviteHolderToPortal", () => {
  it("lets a retry resend after the e-mail failed, and revalidates anyway", async () => {
    const tenant = await seedTenant(owner, "portal");
    actAs(tenant);
    const holderId = await unlinkedHolder(tenant, `novo-${randomUUID()}@example.test`);
    mocks.requestPasswordReset.mockRejectedValueOnce(new Error("smtp down"));

    const first = await inviteHolderToPortal(holderId);

    expect(first.error).toBe("Acesso criado, mas o link para definir a senha falhou. Tente convidar de novo.");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/holders/${holderId}`);
    const profileId = await linkedProfile(holderId);
    expect(profileId).not.toBeNull();

    await expect(inviteHolderToPortal(holderId)).resolves.toEqual({ error: null, id: profileId });
    expect(mocks.requestPasswordReset).toHaveBeenCalledTimes(2);
  });

  it("keeps already_invited once the client has an account", async () => {
    const tenant = await seedTenant(owner, "portal");
    actAs(tenant);
    await addAccount(tenant.client.userId);

    await expect(inviteHolderToPortal(tenant.holder.id)).resolves.toEqual({
      error: "Este Titular já tem acesso ao portal. Revogue antes de reenviar.",
    });
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("rejects an e-mail that belongs to a profile of another bureau", async () => {
    const tenant = await seedTenant(owner, "portal");
    const other = await seedTenant(owner, "portal-other");
    actAs(tenant);
    const holderId = await unlinkedHolder(tenant, await emailOf(other.client.userId));

    await expect(inviteHolderToPortal(holderId)).resolves.toEqual({ error: "Este e-mail já pertence a outra conta." });
    expect(await linkedProfile(holderId)).toBeNull();
    expect(await profileState(other.client.userId)).toBe(true);
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });
});
