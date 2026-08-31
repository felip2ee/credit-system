import { describe, expect, it } from "vitest";

import { hasPermission, type Permission } from "./permissions";

describe("hasPermission", () => {
  it.each(
    [
      ["admin", "clients:read", true],
      ["admin", "clients:write", true],
      ["admin", "consultations:read", true],
      ["admin", "consultations:write", true],
      ["admin", "opportunities:read", true],
      ["admin", "opportunities:write", true],
      ["admin", "reports:read", true],
      ["admin", "reports:write", true],
      ["admin", "settings:read", true],
      ["admin", "settings:write", true],
      ["admin", "users:manage", true],
      ["admin", "audit:read", true],
      ["admin", "portal:read", true],
      ["admin", "portal:write", true],
      ["consultant", "clients:read", true],
      ["consultant", "clients:write", true],
      ["consultant", "consultations:read", true],
      ["consultant", "consultations:write", true],
      ["consultant", "opportunities:read", true],
      ["consultant", "opportunities:write", true],
      ["consultant", "reports:read", true],
      ["consultant", "reports:write", true],
      ["consultant", "settings:read", true],
      ["consultant", "settings:write", false],
      ["consultant", "users:manage", false],
      ["consultant", "audit:read", false],
      ["consultant", "portal:read", false],
      ["consultant", "portal:write", false],
      ["client", "clients:read", false],
      ["client", "clients:write", false],
      ["client", "consultations:read", false],
      ["client", "consultations:write", false],
      ["client", "opportunities:read", false],
      ["client", "opportunities:write", false],
      ["client", "reports:read", false],
      ["client", "reports:write", false],
      ["client", "settings:read", false],
      ["client", "settings:write", false],
      ["client", "users:manage", false],
      ["client", "audit:read", false],
      ["client", "portal:read", true],
      ["client", "portal:write", true],
    ] as const satisfies ReadonlyArray<
      readonly ["admin" | "consultant" | "client", Permission, boolean]
    >,
  )("returns %s for %s to %s", (role, permission, expected) => {
    expect(hasPermission(role, permission)).toBe(expected);
  });
});
