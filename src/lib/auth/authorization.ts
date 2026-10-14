import { pool } from "@/lib/db/pool";
import { withUserTransaction, type AppRole } from "@/lib/db/transaction";

export type AuthProfile = {
  userId: string;
  role: AppRole;
  bureauId: string | null;
  bureauActive: boolean;
  isActive: boolean;
  mfaEnabled: boolean;
  support: { sessionId: string; bureauId: string; expiresAt: Date } | null;
};

function isAppRole(role: string): role is AppRole {
  return role === "superadmin" || role === "bureau_admin" || role === "operator" || role === "client";
}

export async function findAuthProfile(authUserId: string): Promise<AuthProfile | null> {
  const { rows } = await pool.query<{
    userId: string;
    role: string;
    bureauId: string | null;
    bureauActive: boolean;
    isActive: boolean;
    mfaEnabled: boolean;
    supportSessionId: string | null;
    supportBureauId: string | null;
    supportExpiresAt: Date | null;
  }>(
    `select user_id as "userId", role, bureau_id as "bureauId", bureau_active as "bureauActive",
            is_active as "isActive", mfa_enabled as "mfaEnabled",
            support_session_id as "supportSessionId", support_bureau_id as "supportBureauId",
            support_expires_at as "supportExpiresAt"
       from auth_profile_for_session($1)`,
    [authUserId],
  );
  const row = rows[0];
  if (!row || !isAppRole(row.role)) return null;
  const support =
    row.supportSessionId && row.supportBureauId && row.supportExpiresAt
      ? { sessionId: row.supportSessionId, bureauId: row.supportBureauId, expiresAt: row.supportExpiresAt }
      : null;
  return {
    userId: row.userId,
    role: row.role,
    bureauId: row.bureauId,
    bureauActive: row.bureauActive,
    isActive: row.isActive,
    mfaEnabled: row.mfaEnabled,
    support,
  };
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await pool.query('delete from "session" where user_id = $1', [userId]);
}

async function withAdministratorTransaction<T>(
  actorUserId: string,
  work: Parameters<typeof withUserTransaction<T>>[1],
): Promise<T> {
  const actor = await findAuthProfile(actorUserId);
  if (!actor?.isActive || !actor.bureauActive || actor.role !== "bureau_admin") {
    throw new Error("administrator authorization is required");
  }
  return withUserTransaction({ userId: actor.userId, role: actor.role, bureauId: actor.bureauId }, work);
}

export async function changeRoleAndRevokeSessions(
  actorUserId: string,
  userId: string,
  role: "bureau_admin" | "operator",
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
