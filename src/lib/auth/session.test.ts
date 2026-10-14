import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findAuthProfile: vi.fn(),
  revokeUserSessions: vi.fn(),
  query: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("./server", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("./authorization", () => ({
  findAuthProfile: mocks.findAuthProfile,
  revokeUserSessions: mocks.revokeUserSessions,
}));
vi.mock("@/lib/db/pool", () => ({ pool: { query: mocks.query } }));

import { getRequiredSessionFromHeaders, SessionAccessError, sessionErrorPath } from "./session";

const NOW = Date.parse("2026-10-14T12:00:00Z");

function arrange(role: string, { mfa, flagged }: { mfa: boolean; flagged: boolean }) {
  mocks.getSession.mockResolvedValue({
    user: { id: "u1", name: "Nome", email: "u@example.test", twoFactorEnabled: mfa },
    session: { id: "s1", createdAt: new Date(NOW - 1_000), updatedAt: new Date(NOW - 1_000) },
  });
  mocks.findAuthProfile.mockResolvedValue({
    userId: "u1",
    role,
    bureauId: role === "superadmin" ? null : "b1",
    bureauActive: true,
    isActive: true,
    mfaEnabled: mfa,
    mustChangePassword: flagged,
    support: null,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("must_change_password gate", () => {
  it.each([
    ["superadmin", true],
    ["bureau_admin", true],
    ["operator", true],
    ["client", false],
  ])("flagged profile is blocked for every role: %s", async (role, mfa) => {
    arrange(role, { mfa, flagged: true });

    await expect(getRequiredSessionFromHeaders(new Headers(), NOW)).rejects.toMatchObject({
      code: "password_change_required",
    });
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
  });

  it("missing MFA wins over the flag", async () => {
    arrange("operator", { mfa: false, flagged: true });

    await expect(getRequiredSessionFromHeaders(new Headers(), NOW)).rejects.toMatchObject({
      code: "mfa_setup_required",
    });
  });

  it("returns the session when the flag is off", async () => {
    arrange("operator", { mfa: true, flagged: false });

    await expect(getRequiredSessionFromHeaders(new Headers(), NOW)).resolves.toMatchObject({
      userId: "u1",
      role: "operator",
    });
  });
});

describe("sessionErrorPath", () => {
  it("maps each access error to its page", () => {
    expect(sessionErrorPath(new SessionAccessError("mfa_setup_required"))).toBe("/mfa/setup");
    expect(sessionErrorPath(new SessionAccessError("password_change_required"))).toBe("/change-password");
    expect(sessionErrorPath(new SessionAccessError("session_required"))).toBe("/login");
    expect(sessionErrorPath(new Error("boom"))).toBe("/login");
  });
});
