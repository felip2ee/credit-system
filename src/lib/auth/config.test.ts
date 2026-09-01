import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "https://credit.example.test",
    TRAEFIK_PROXY_CIDR: "10.0.0.0/8",
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

import { authConfig } from "./config";

describe("authConfig production cookies", () => {
  // Catches: disabling Better Auth's secure-cookie mode in the production container.
  it("keeps host-scoped secure, HTTP-only, Lax cookies", () => {
    expect(authConfig.advanced?.cookiePrefix).toBe("__Host-credit-system");
    expect(authConfig.advanced?.useSecureCookies).toBe(true);
    expect(authConfig.advanced?.defaultCookieAttributes).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
