import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-0000-0000-0000000000b1";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  createInvite: vi.fn(),
  sendInviteEmail: vi.fn(),
  allowedPermission: "any",
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({
    userId: "00000000-0000-0000-0000-000000000001",
    role: "bureau_admin",
    bureauId: "00000000-0000-0000-0000-0000000000b1",
  })),
}));
vi.mock("@/lib/db/permissions", () => ({
  hasPermission: vi.fn((_subject, permission) => state.allowedPermission === "any" || permission === state.allowedPermission),
}));
vi.mock("@/lib/db/transaction", () => ({
  withUserTransaction: vi.fn(async (_identity, work) => work({ query: state.query })),
}));
vi.mock("@/lib/audit/write", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("@/lib/auth/invite", () => ({
  createInvite: state.createInvite,
  sendInviteEmail: state.sendInviteEmail,
}));

import { inviteHolderToPortal } from "./portal";

beforeEach(() => {
  state.allowedPermission = "any";
  state.createInvite.mockReset();
  state.sendInviteEmail.mockReset().mockResolvedValue(true);
  state.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("from holders where id")) {
      return { rows: [{ id: "holder-id", name: "Portal Holder", email: "client@example.test", client_profile_id: null }] };
    }
    return { rows: [], rowCount: 1 };
  });
});

describe("inviteHolderToPortal", () => {
  it("requires users:manage before inviting a portal client", async () => {
    state.allowedPermission = "forbidden:permission";

    await expect(inviteHolderToPortal("holder-id")).resolves.toEqual({
      error: "Apenas a equipe pode conceder acesso ao portal.",
    });
    expect(state.createInvite).not.toHaveBeenCalled();
  });

  it("invites with role client in the caller bureau, links the holder and sends the reset link", async () => {
    state.createInvite.mockResolvedValue({ ok: true, userId: "new-user", resent: false });

    await expect(inviteHolderToPortal("holder-id")).resolves.toEqual({ error: null, id: "new-user" });

    expect(state.createInvite).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000001",
      { email: "client@example.test", fullName: "Portal Holder", role: "client", bureauId: BUREAU_ID },
    );
    expect(state.query).toHaveBeenCalledWith(
      "update holders set client_profile_id = $2 where id = $1",
      ["holder-id", "new-user"],
    );
    expect(state.sendInviteEmail).toHaveBeenCalledWith("client@example.test");
  });

  it("returns the account-in-use message when the e-mail belongs to another account", async () => {
    state.createInvite.mockResolvedValue({ ok: false, reason: "email_in_use" });

    await expect(inviteHolderToPortal("holder-id")).resolves.toEqual({
      error: "Este e-mail já pertence a outra conta.",
    });
    expect(state.sendInviteEmail).not.toHaveBeenCalled();
  });
});
