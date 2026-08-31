import { describe, expect, it, vi } from "vitest";

const handler = vi.hoisted(() =>
  vi.fn(async (request: Request) => {
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.startsWith("application/json")
      ? await request.json()
      : Object.fromEntries(new URLSearchParams(await request.text()));
    return Response.json({ contentType, body });
  }),
);

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

vi.mock("better-auth", () => ({ betterAuth: () => ({ handler }) }));

import { authHandler } from "./server";

describe("authHandler", () => {
  it("revokes other sessions for form-encoded password changes", async () => {
    const response = await authHandler(
      new Request("http://localhost:3000/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          currentPassword: "twelve-character-password",
          newPassword: "another-twelve-character-password",
        }),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      contentType: "application/json",
      body: {
        currentPassword: "twelve-character-password",
        newPassword: "another-twelve-character-password",
        revokeOtherSessions: true,
      },
    });
  });

  it("rejects form-encoded trusted-device MFA requests", async () => {
    const response = await authHandler(
      new Request("http://localhost:3000/api/auth/two-factor/verify-totp", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "123456", trustDevice: "true" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "TRUST_DEVICE_DISABLED",
    });
  });
});
