import { describe, expect, it } from "vitest";

import { hasPermission, permissionsFor, permissions, type Permission } from "./permissions";

const SUPPORT = "11111111-1111-4111-8111-111111111111";

const tenantData: Permission[] = [
  "holders:read",
  "holders:write",
  "consultations:read",
  "consultations:write",
  "reports:read",
  "reports:write",
];

const matrix: Record<string, { subject: Parameters<typeof permissionsFor>[0]; allowed: Permission[] }> = {
  superadmin: {
    subject: { role: "superadmin" },
    allowed: [
      "bureaus:manage",
      "support:enter",
      "settings:read",
      "settings:write",
      "catalog:read",
      "catalog:write",
      "wallet:read",
      "wallet:adjust",
      "payout:manage",
      "nfse:manage",
      "notifications:manage",
      "payout:read",
    ],
  },
  "superadmin in support": {
    subject: { role: "superadmin", supportSessionId: SUPPORT },
    allowed: [
      "bureaus:manage",
      "support:enter",
      "settings:read",
      "settings:write",
      "catalog:read",
      "catalog:write",
      "wallet:read",
      "wallet:adjust",
      "payout:manage",
      "nfse:manage",
      "notifications:manage",
      "payout:read",
      "counter:read",
      "counter:write",
      ...tenantData,
    ],
  },
  bureau_admin: {
    subject: { role: "bureau_admin" },
    allowed: [
      ...tenantData,
      "settings:read",
      "catalog:read",
      "catalog:write",
      "wallet:read",
      "wallet:topup",
      "users:manage",
      "audit:read",
      "portal:read",
      "portal:write",
      "counter:read",
      "counter:write",
      "payout:read",
      "lgpd:manage",
    ],
  },
  operator: {
    subject: { role: "operator" },
    allowed: [...tenantData, "settings:read", "catalog:read", "wallet:read", "counter:read", "counter:write"],
  },
  client: {
    subject: { role: "client" },
    allowed: ["portal:read", "portal:write", "credits:read", "credits:topup"],
  },
};

describe("hasPermission", () => {
  describe.each(Object.entries(matrix))("%s", (_name, { subject, allowed }) => {
    it.each(permissions)("%s", (permission) => {
      expect(hasPermission(subject, permission)).toBe(allowed.includes(permission));
    });
  });

  it("ignores a support session on non-superadmin roles", () => {
    expect(hasPermission({ role: "client", supportSessionId: SUPPORT }, "holders:read")).toBe(false);
    expect(hasPermission({ role: "bureau_admin", supportSessionId: SUPPORT }, "bureaus:manage")).toBe(false);
  });

  it("treats a null support session as absent", () => {
    expect(hasPermission({ role: "superadmin", supportSessionId: null }, "holders:read")).toBe(false);
  });
});

describe("lgpd:manage", () => {
  it("bureau_admin has lgpd:manage", () => {
    expect(hasPermission({ role: "bureau_admin" }, "lgpd:manage")).toBe(true);
  });

  it("operator superadmin and client do not have lgpd:manage", () => {
    expect(hasPermission({ role: "operator" }, "lgpd:manage")).toBe(false);
    expect(hasPermission({ role: "superadmin" }, "lgpd:manage")).toBe(false);
    expect(hasPermission({ role: "superadmin", supportSessionId: SUPPORT }, "lgpd:manage")).toBe(false);
    expect(hasPermission({ role: "client" }, "lgpd:manage")).toBe(false);
  });
});

describe("permissionsFor", () => {
  it("lists the same permissions hasPermission accepts", () => {
    const subject = { role: "superadmin", supportSessionId: SUPPORT } as const;
    expect(permissionsFor(subject).every((p) => hasPermission(subject, p))).toBe(true);
    expect(permissionsFor(subject)).not.toContain("users:manage");
  });
});
