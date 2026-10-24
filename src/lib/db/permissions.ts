import type { DbIdentity } from "./transaction";

export const permissions = [
  "holders:read",
  "holders:write",
  "consultations:read",
  "consultations:write",
  "reports:read",
  "reports:write",
  "settings:read",
  "settings:write",
  "users:manage",
  "audit:read",
  "portal:read",
  "portal:write",
  "bureaus:manage",
  "support:enter",
  "catalog:read",
  "catalog:write",
  "wallet:read",
  "wallet:topup",
  "wallet:adjust",
  "credits:read",
  "credits:topup",
  "counter:read",
  "counter:write",
  "payout:read",
  "payout:manage",
  "nfse:manage",
  "notifications:manage",
  "lgpd:manage",
] as const;

export type Permission = (typeof permissions)[number];

export type PermissionSubject = Pick<DbIdentity, "role" | "supportSessionId">;

const operatorPermissions = [
  "holders:read",
  "holders:write",
  "consultations:read",
  "consultations:write",
  "reports:read",
  "reports:write",
  "settings:read",
  "catalog:read",
  "wallet:read",
  "counter:read",
  "counter:write",
] as const satisfies readonly Permission[];

export const rolePermissions = {
  superadmin: [
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
  bureau_admin: [
    ...operatorPermissions,
    "catalog:write",
    "wallet:topup",
    "users:manage",
    "audit:read",
    "portal:read",
    "portal:write",
    "payout:read",
    "lgpd:manage",
  ],
  operator: operatorPermissions,
  client: ["portal:read", "portal:write", "credits:read", "credits:topup"],
} as const satisfies Record<DbIdentity["role"], readonly Permission[]>;

// Superadmin sem sessão de suporte não lê dados de tenant; em suporte, ganha as permissões do operator.
export function permissionsFor(subject: PermissionSubject): readonly Permission[] {
  const base: readonly Permission[] = rolePermissions[subject.role];
  if (subject.role === "superadmin" && subject.supportSessionId) {
    const inSupport: readonly Permission[] = operatorPermissions;
    return permissions.filter((p) => base.includes(p) || inSupport.includes(p));
  }
  return base;
}

export function hasPermission(subject: PermissionSubject, permission: Permission): boolean {
  return permissionsFor(subject).includes(permission);
}
