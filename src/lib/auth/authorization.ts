import { pool } from "@/lib/db/pool";
import { rolePermissions, type Permission } from "@/lib/db/permissions";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type AuthRole = DbIdentity["role"];

export type AuthProfile = {
  userId: string;
  role: AuthRole;
  isActive: boolean;
  mfaEnabled: boolean;
};

function isAuthRole(role: string): role is AuthRole {
  return role === "admin" || role === "consultant" || role === "client";
}

export async function findAuthProfile(authUserId: string): Promise<AuthProfile | null> {
  const { rows } = await pool.query<{
    userId: string;
    role: string;
    isActive: boolean;
    mfaEnabled: boolean;
  }>(
    'select user_id as "userId", role, is_active as "isActive", mfa_enabled as "mfaEnabled" from auth_profile_for_session($1)',
    [authUserId],
  );
  const profile = rows[0];
  if (!profile || !isAuthRole(profile.role)) return null;
  return { ...profile, role: profile.role };
}

export function permissionsFor(role: AuthRole): readonly Permission[] {
  return rolePermissions[role];
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await pool.query('delete from "session" where user_id = $1', [userId]);
}

async function withAdministratorTransaction<T>(
  actorUserId: string,
  work: Parameters<typeof withUserTransaction<T>>[1],
): Promise<T> {
  const actor = await findAuthProfile(actorUserId);
  if (!actor?.isActive || actor.role !== "admin") {
    throw new Error("administrator authorization is required");
  }
  return withUserTransaction(actor, work);
}

export async function changeRoleAndRevokeSessions(
  actorUserId: string,
  userId: string,
  role: AuthRole,
): Promise<void> {
  await withAdministratorTransaction(actorUserId, async (client) => {
    const result = await client.query(
      "update profiles set role = $1, updated_at = now() where id = $2",
      [role, userId],
    );
    if (result.rowCount !== 1) throw new Error("profile not found");
    await client.query('delete from "session" where user_id = $1', [userId]);
  });
}

export async function deactivateUserAndRevokeSessions(
  actorUserId: string,
  userId: string,
): Promise<void> {
  await withAdministratorTransaction(actorUserId, async (client) => {
    const result = await client.query(
      "update profiles set is_active = false, updated_at = now() where id = $1",
      [userId],
    );
    if (result.rowCount !== 1) throw new Error("profile not found");
    await client.query('delete from "session" where user_id = $1', [userId]);
  });
}
