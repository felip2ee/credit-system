import { pool } from "@/lib/db/pool";
import type { AppRole } from "@/lib/db/transaction";

export type AuthProfile = {
  userId: string;
  role: AppRole;
  bureauId: string | null;
  bureauActive: boolean;
  isActive: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
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
    mustChangePassword: boolean;
    supportSessionId: string | null;
    supportBureauId: string | null;
    supportExpiresAt: Date | null;
  }>(
    `select user_id as "userId", role, bureau_id as "bureauId", bureau_active as "bureauActive",
            is_active as "isActive", mfa_enabled as "mfaEnabled",
            must_change_password as "mustChangePassword",
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
    mustChangePassword: row.mustChangePassword,
    support,
  };
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await pool.query('delete from "session" where user_id = $1', [userId]);
}
