import type { DbIdentity } from "./transaction";

export const permissions = [
  "clients:read",
  "clients:write",
  "consultations:read",
  "consultations:write",
  "opportunities:read",
  "opportunities:write",
  "reports:read",
  "reports:write",
  "settings:read",
  "settings:write",
  "users:manage",
  "audit:read",
  "portal:read",
  "portal:write",
] as const;

export type Permission = (typeof permissions)[number];

export const rolePermissions = {
  admin: permissions,
  consultant: [
    "clients:read",
    "clients:write",
    "consultations:read",
    "consultations:write",
    "opportunities:read",
    "opportunities:write",
    "reports:read",
    "reports:write",
    "settings:read",
  ],
  client: ["portal:read", "portal:write"],
} as const satisfies Record<DbIdentity["role"], readonly Permission[]>;

export function hasPermission(
  role: DbIdentity["role"],
  permission: Permission,
): boolean {
  return (rolePermissions[role] as readonly Permission[]).includes(permission);
}
