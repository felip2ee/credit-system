import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.DATABASE_URL ??= "postgres://app_runtime:test@localhost:54329/credit_system";
  process.env.DOCUMENT_ROOT ??= "/tmp/reino-test-documents";
  process.env.CLAMAV_HOST ??= "localhost";
  process.env.CLAMAV_PORT ??= "3310";
  process.env.SMTP_HOST ??= "smtp.example.test";
  process.env.SMTP_PORT ??= "465";
  process.env.SMTP_SECURE ??= "true";
  process.env.SMTP_USER ??= "credit-system";
  process.env.SMTP_PASS ??= "test-password";
});

import { isUsableScrAuthorization } from "./queries";

describe("isUsableScrAuthorization", () => {
  it("rejects pending and expired authorizations while accepting a live authorization", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");

    expect(isUsableScrAuthorization("pending", null, now)).toBe(false);
    expect(isUsableScrAuthorization("authorized", "2026-08-31T11:59:59.000Z", now)).toBe(false);
    expect(isUsableScrAuthorization("authorized", "2026-09-01T00:00:00.000Z", now)).toBe(true);
  });
});
