import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const resetEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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

vi.mock("./email", () => ({ sendPasswordResetEmail: resetEmail }));

import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";

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

type TestUser = {
  id: string;
  email: string;
  role: "admin" | "consultant" | "client";
};

const testUsers: TestUser[] = [];

function authRequest(
  path: string,
  body: Record<string, unknown>,
  headers?: HeadersInit,
) {
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

async function createUser(role: TestUser["role"]): Promise<TestUser> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  const user = { id, email, role };
  const passwordHash = await hashPassword(password);

  await pool.query(
    'insert into "user" (id, name, email, two_factor_enabled) values ($1, $2, $3, false)',
    [id, `Auth test ${role}`, email],
  );
  await withUserTransaction({ userId: id, role: "admin" }, async (client) => {
    await client.query(
      "insert into profiles (id, auth_user_id, full_name, email, role, mfa_enabled) values ($1, $1, $2, $3, $4, false)",
      [id, `Auth test ${role}`, email, role],
    );
  });
  await pool.query(
    "insert into account (id, issuer, account_id, provider_id, user_id, password) values ($1, 'local:credential', $2, 'credential', $2, $3)",
    [randomUUID(), id, passwordHash],
  );
  testUsers.push(user);
  return user;
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
    if (testUsers.length) {
      const ids = testUsers.map(({ id }) => id);
      await withUserTransaction(
        { userId: ids[0], role: "admin" },
        async (client) => client.query("delete from profiles where id = any($1::uuid[])", [ids]),
      );
      await pool.query('delete from "user" where id = any($1::text[])', [ids]);
    }
    await pool.end();
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

  it("creates a database session when a preserved UUID user signs in", async () => {
    const user = await createUser("client");
    const headers = await login(user);
    const { rows } = await pool.query<{ userId: string }>(
      'select user_id as "userId" from "session" where user_id = $1',
      [user.id],
    );

    expect(rows).toEqual([{ userId: user.id }]);
    await expect(getRequiredSessionFromHeaders(headers)).resolves.toEqual({
      userId: user.id,
      role: "client",
      permissions: ["portal:read", "portal:write"],
      mfaComplete: false,
    });
  });

  it("revokes an idle session after thirty minutes and writes activity no more than once per five minutes", async () => {
    const user = await createUser("client");
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
    const user = await createUser("client");
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
    const user = await createUser("client");
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
    const user = await createUser("client");
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

  it("returns mfa_setup_required and revokes the session for staff without TOTP", async () => {
    const user = await createUser("consultant");
    const headers = await login(user);

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "mfa_setup_required",
    } satisfies Partial<SessionAccessError>);
    await expect(
      pool.query('select 1 from "session" where user_id = $1', [user.id]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("revokes every session when an administrator changes a user role", async () => {
    const administrator = await createUser("admin");
    const user = await createUser("client");
    const headers = await login(user);

    await changeRoleAndRevokeSessions(administrator.id, user.id, "consultant");

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "session_required",
    } satisfies Partial<SessionAccessError>);
  });

  it("revokes every session when an administrator deactivates a user", async () => {
    const administrator = await createUser("admin");
    const user = await createUser("client");
    const headers = await login(user);

    await deactivateUserAndRevokeSessions(administrator.id, user.id);

    await expect(getRequiredSessionFromHeaders(headers)).rejects.toMatchObject({
      code: "session_required",
    } satisfies Partial<SessionAccessError>);
  });
});
