import { describe, expect, it } from "vitest";

import { hasPermission } from "./permissions";

describe("hasPermission", () => {
  it("denies capabilities that a role does not receive", () => {
    expect(hasPermission("admin", "users:manage")).toBe(true);
    expect(hasPermission("consultant", "settings:write")).toBe(false);
    expect(hasPermission("client", "clients:read")).toBe(false);
  });
});
