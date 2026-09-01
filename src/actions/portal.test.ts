import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  requestPasswordReset: vi.fn(),
  sendMail: vi.fn(),
  allowedPermission: "any",
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "00000000-0000-0000-0000-000000000001", role: "admin" })),
}));
vi.mock("@/lib/db/permissions", () => ({
  hasPermission: vi.fn((_role, permission) => state.allowedPermission === "any" || permission === state.allowedPermission),
}));
vi.mock("@/lib/db/transaction", () => ({
  withUserTransaction: vi.fn(async (_identity, work) => work({ query: state.query })),
}));
vi.mock("@/lib/audit/write", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { requestPasswordReset: state.requestPasswordReset } },
}));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "http://localhost:3000" } }));
vi.mock("@/lib/email/mailer", () => ({ sendMail: state.sendMail }));

import { inviteClientToPortal } from "./portal";

describe("inviteClientToPortal", () => {
  it("requires users:manage before inviting a portal client", async () => {
    state.allowedPermission = "users:manage";
    state.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id, name, email, user_id from crm_clients")) {
        return { rows: [{ id: "client-id", name: "Portal Client", email: "client@example.test", user_id: null }] };
      }
      if (sql.includes('select id from "user"')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });

    await expect(inviteClientToPortal("client-id")).resolves.toMatchObject({ error: null });
  });

  it("creates the portal identity through a reset link without sending a password email", async () => {
    state.allowedPermission = "any";
    state.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id, name, email, user_id from crm_clients")) {
        return { rows: [{ id: "client-id", name: "Portal Client", email: "client@example.test", user_id: null }] };
      }
      if (sql.includes('select id from "user"')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });

    await expect(inviteClientToPortal("client-id")).resolves.toEqual({
      error: null,
      id: expect.any(String),
    });
    expect(state.requestPasswordReset).toHaveBeenCalledWith({
      body: { email: "client@example.test", redirectTo: "http://localhost:3000/update-password" },
    });
    expect(state.sendMail).not.toHaveBeenCalled();
  });
});
