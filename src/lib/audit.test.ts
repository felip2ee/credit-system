import { describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
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

import { auditEventFromParams } from "./audit";

describe("legacy audit helper", () => {
  it("maps caller data into the PostgreSQL audit event", () => {
    expect(
      auditEventFromParams("actor-id", {
        action: "portal.invite",
        tableName: "crm_clients",
        recordId: "record-id",
        data: { email: "client@example.test" },
      }),
    ).toEqual({
      actorId: "actor-id",
      action: "portal.invite",
      targetTable: "crm_clients",
      targetId: "record-id",
      outcome: "success",
      metadata: { email: "client@example.test" },
    });
  });
});
