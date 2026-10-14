import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const resetEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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

vi.mock("./email", () => ({ sendPasswordResetEmail: resetEmail }));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedSupportSession, seedTenant, type SeededTenant } from "@/test/seed";

import {
  changeRoleAndRevokeSessions,
  deactivateUserAndRevokeSessions,
} from "./authorization";
import { authHandler } from "./server";
import {
  getRequiredSessionFromHeaders,
  SessionAccessError,
} from "./session";

const password = "twelve-character-password";
const resetPassword = "another-twelve-character-password";

type TestUser = { id: string; email: string };

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

async function authRequest(
  path: string,
  body: Record<string, unknown>,
  headers?: HeadersInit,
) {
  // Every request shares one IP; clear the limiter so it does not hide what the test checks.
  await pool.query("delete from rate_limit");
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return authHandler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    }),
  );
}

function sessionHeaders(response: Response): Headers {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("expected Better Auth to set a session cookie");
  return new Headers({ cookie: cookie.split(";", 1)[0] });
}

// Seeded users have no credential account: give them one. Password sign-in only issues a
// session while MFA is off, so use loginWithMfa to enrol after signing in.
async function enable(userId: string): Promise<TestUser> {
  const email = `${userId}@example.test`;
  await owner.query(
    "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, $3, now())",
    [randomUUID(), userId, await hashPassword(password)],
  );
  return { id: userId, email };
}

async function loginWithMfa(user: TestUser): Promise<Headers> {
  const headers = await login(user);
  await owner.query('update "user" set two_factor_enabled = true where id = $1', [user.id]);
  return headers;
}

async function freshTenant(): Promise<SeededTenant> {
  return seedTenant(owner, "auth");
}

async function clientUser(): Promise<TestUser> {
  return enable((await freshTenant()).client.userId);
}

async function login(user: TestUser, userPassword = password) {
  const response = await authRequest("/sign-in/email", {
    email: user.email,
    password: userPassword,
  });
  expect(response.status).toBe(200);
  return sessionHeaders(response);
}

describe("Better Auth transport guard", () => {
  it("rejects trusted-device MFA requests", async () => {
    const response = await authRequest("/two-factor/verify-totp", {
      code: "123456",
      trustDevice: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "TRUST_DEVICE_DISABLED",
    });
  });
});

describe.sequential("Better Auth PostgreSQL integration", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  afterAll(async () => {
    try {
      await owner.end();
    } finally {
      await pool.end();
    }
  });

  it("rejects public email/password signup", async () => {
    const response = await authRequest("/sign-up/email", {
      name: "Public signup",
      email: "public-signup@example.test",
      password,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    });
  });

  it("blocks a fourth sign-in within ten seconds with a sane X-Retry-After", async () => {
    // Better Auth default for /sign-in: 3 requests per 10 s. authRequest clears the limiter, so send raw requests.
    await pool.query("delete from rate_limit");
    const signIn = () =>
      authHandler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@example.test", password }),
        }),
      );
    try {
      const statuses: number[] = [];
      let blocked: Response | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await signIn();
        statuses.push(response.status);
        blocked = response;
      }

      expect(statuses[3]).toBe(429);
      const { rowCount } = await pool.query(
        "select 1 from rate_limit where key like '%/sign-in/email'",
      );
      expect(rowCount).toBeGreaterThan(0);
      const retryAfter = Number(blocked?.headers.get("x-retry-after"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThan(3600);
    } finally {
      await pool.query("delete from rate_limit where key like '%/sign-in/email'");
    }
  });

  it("creates a database session when a preserved UUID user signs in", async () => {
    const user = await clientUser();
    const headers = await login(user);
    const { rows } = await pool.query<{ userId: string }>(
      'select user_id as "userId" from "session" where user_id = $1',
      [user.id],
    );

    expect(rows).toEqual([{ userId: user.id }]);
    await expect(getRequiredSessionFromHeaders(headers)).resolves.toMatchObject({
      userId: user.id,
      role: "client",
      supportSessionId: null,
      support: null,
      permissions: ["portal:read", "portal:write"],
      mfaComplete: false,
      email: user.email,
    });
  });

  it("revokes an idle session after thirty minutes and writes activity no more than once per five minutes", async () => {
    const user = await clientUser();
    const headers = await login(user);
    await pool.query(
      'update "session" set updated_at = now() - interval \'31 minutes\' where user_id = $1',
      [user.id],
    );

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "session_idle_expired",
    } satisfies Partial<SessionAccessError>);
    await expect(
      pool.query('select 1 from "session" where user_id = $1', [user.id]),
    ).resolves.toMatchObject({ rows: [] });

    const activeHeaders = await login(user);
    await pool.query(
      'update "session" set updated_at = now() - interval \'6 minutes\' where user_id = $1',
      [user.id],
    );
    await getRequiredSessionFromHeaders(activeHeaders);
    const first = await pool.query<{ updatedAt: Date }>(
      'select updated_at as "updatedAt" from "session" where user_id = $1',
      [user.id],
    );
    await getRequiredSessionFromHeaders(activeHeaders);
    const second = await pool.query<{ updatedAt: Date }>(
      'select updated_at as "updatedAt" from "session" where user_id = $1',
      [user.id],
    );

    expect(second.rows[0].updatedAt.getTime()).toBe(first.rows[0].updatedAt.getTime());
  });

  it("revokes a session older than twenty-four hours even when its database expiry is later", async () => {
    const user = await clientUser();
    const headers = await login(user);
    await pool.query(
      'update "session" set created_at = now() - interval \'25 hours\', expires_at = now() + interval \'1 hour\' where user_id = $1',
      [user.id],
    );

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "session_absolute_expired",
    } satisfies Partial<SessionAccessError>);
    await expect(
      pool.query('select 1 from "session" where user_id = $1', [user.id]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("issues single-use password reset links that expire after fifteen minutes", async () => {
    const user = await clientUser();
    const sessionBeforeRecovery = await login(user);
    const response = await authRequest("/request-password-reset", {
      email: user.email,
      redirectTo: "http://localhost:3000/auth/reset-password",
    });
    expect(response.status).toBe(200);

    const { rows } = await pool.query<{ identifier: string; expiresAt: Date }>(
      "select identifier, expires_at as \"expiresAt\" from verification where value = $1 and identifier like 'reset-password:%'",
      [user.id],
    );
    const token = rows[0].identifier.replace("reset-password:", "");

    expect(rows[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);

    await expect(
      authRequest("/reset-password", { token, newPassword: resetPassword }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(getRequiredSessionFromHeaders(sessionBeforeRecovery)).rejects.toMatchObject({
      code: "session_required",
    } satisfies Partial<SessionAccessError>);
    await expect(
      authRequest("/reset-password", { token, newPassword: resetPassword }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it("revokes every session when a password is changed", async () => {
    const user = await clientUser();
    const passwordChangeHeaders = await login(user);
    const otherSessionHeaders = await login(user);

    const response = await authRequest(
      "/change-password",
      { currentPassword: password, newPassword: resetPassword },
      passwordChangeHeaders,
    );

    expect(response.status).toBe(200);
    await expect(getRequiredSessionFromHeaders(otherSessionHeaders)).rejects.toMatchObject({
      code: "session_required",
    } satisfies Partial<SessionAccessError>);
  });

  it.each(["superadmin", "bureau_admin", "operator"] as const)(
    "returns mfa_setup_required for %s without MFA but keeps the session so staff can enrol",
    async (role) => {
      const tenant = await freshTenant();
      const userId = role === "superadmin" ? (await seedSuperadmin(owner)).userId : tenant[role === "bureau_admin" ? "bureauAdmin" : "operator"].userId;
      const user = await enable(userId);
      const headers = await login(user);

      await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
        code: "mfa_setup_required",
      } satisfies Partial<SessionAccessError>);
      await expect(
        pool.query('select 1 from "session" where user_id = $1', [user.id]),
      ).resolves.toMatchObject({ rows: [{ "?column?": 1 }] });
    },
  );

  it("loads the bureau of an operator of an active bureau", async () => {
    const tenant = await freshTenant();
    const user = await enable(tenant.operator.userId);

    await expect(getRequiredSessionFromHeaders(await loginWithMfa(user))).resolves.toMatchObject({
      userId: user.id,
      role: "operator",
      bureauId: tenant.bureau.id,
      supportSessionId: null,
      support: null,
      mfaComplete: true,
    });
  });

  it("rejects an inactive bureau with bureau_inactive and revokes the sessions", async () => {
    const tenant = await freshTenant();
    const user = await enable(tenant.operator.userId);
    const headers = await login(user);
    await owner.query("update bureaus set status = 'inactive' where id = $1", [tenant.bureau.id]);

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "bureau_inactive",
    } satisfies Partial<SessionAccessError>);
    await expect(
      pool.query('select 1 from "session" where user_id = $1', [user.id]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("gives an active support session to a superadmin, even for an inactive bureau", async () => {
    const tenant = await freshTenant();
    await owner.query("update bureaus set status = 'inactive' where id = $1", [tenant.bureau.id]);
    const superadmin = await seedSuperadmin(owner);
    const supportSessionId = await seedSupportSession(owner, {
      superadminId: superadmin.userId,
      bureauId: tenant.bureau.id,
    });
    const user = await enable(superadmin.userId);

    const session = await getRequiredSessionFromHeaders(await loginWithMfa(user));

    expect(session).toMatchObject({
      role: "superadmin",
      bureauId: tenant.bureau.id,
      supportSessionId,
      support: { bureauId: tenant.bureau.id },
    });
    expect(session.permissions).toContain("holders:read");
  });

  it("superadmin without support has no bureau", async () => {
    const superadmin = await seedSuperadmin(owner);
    const user = await enable(superadmin.userId);

    const session = await getRequiredSessionFromHeaders(await loginWithMfa(user));

    expect(session).toMatchObject({ bureauId: null, supportSessionId: null, support: null });
    expect(session.permissions).not.toContain("holders:read");
  });

  it("expired support is not loaded", async () => {
    const tenant = await freshTenant();
    const superadmin = await seedSuperadmin(owner);
    await seedSupportSession(owner, {
      superadminId: superadmin.userId,
      bureauId: tenant.bureau.id,
      startedAt: new Date(Date.now() - 2 * 3_600_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const user = await enable(superadmin.userId);

    await expect(getRequiredSessionFromHeaders(await loginWithMfa(user))).resolves.toMatchObject({
      bureauId: null,
      supportSessionId: null,
      support: null,
    });
  });

  it("revokes every session when an administrator changes a user role", async () => {
    const tenant = await freshTenant();
    const administrator = await enable(tenant.bureauAdmin.userId);
    const user = await enable(tenant.operator.userId);
    const headers = await login(user);

    await changeRoleAndRevokeSessions(administrator.id, user.id, "bureau_admin");

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "session_required",
    } satisfies Partial<SessionAccessError>);
  });

  it("revokes every session when an administrator deactivates a user", async () => {
    const tenant = await freshTenant();
    const administrator = await enable(tenant.bureauAdmin.userId);
    const user = await enable(tenant.operator.userId);
    const headers = await login(user);

    await deactivateUserAndRevokeSessions(administrator.id, user.id);

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "session_required",
    } satisfies Partial<SessionAccessError>);
  });

  it("does not let an administrator touch a user of another bureau", async () => {
    const mine = await freshTenant();
    const other = await freshTenant();

    await expect(
      deactivateUserAndRevokeSessions(mine.bureauAdmin.userId, other.operator.userId),
    ).rejects.toThrow("profile not found");
    await expect(
      changeRoleAndRevokeSessions(mine.bureauAdmin.userId, other.operator.userId, "bureau_admin"),
    ).rejects.toThrow("profile not found");
  });

  it("requires an active bureau_admin of an active bureau to administer users", async () => {
    const tenant = await freshTenant();

    await expect(
      deactivateUserAndRevokeSessions(tenant.operator.userId, tenant.client.userId),
    ).rejects.toThrow("administrator authorization is required");

    await owner.query("update bureaus set status = 'inactive' where id = $1", [tenant.bureau.id]);
    await expect(
      deactivateUserAndRevokeSessions(tenant.bureauAdmin.userId, tenant.operator.userId),
    ).rejects.toThrow("administrator authorization is required");
  });
});
