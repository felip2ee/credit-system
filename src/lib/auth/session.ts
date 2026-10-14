import { headers } from "next/headers";

import { auth } from "./server";
import { findAuthProfile, revokeUserSessions } from "./authorization";
import { pool } from "@/lib/db/pool";
import { permissionsFor, type Permission } from "@/lib/db/permissions";
import type { DbIdentity } from "@/lib/db/transaction";

const ABSOLUTE_SESSION_MS = 24 * 60 * 60 * 1_000;
const IDLE_SESSION_MS = 30 * 60 * 1_000;
const ACTIVITY_WRITE_MS = 5 * 60 * 1_000;

export class SessionAccessError extends Error {
  constructor(
    readonly code:
      | "session_required"
      | "session_idle_expired"
      | "session_absolute_expired"
      | "mfa_setup_required"
      | "user_deactivated"
      | "bureau_inactive",
  ) {
    super(code);
  }
}

export type RequiredSession = DbIdentity & {
  permissions: readonly Permission[];
  mfaComplete: boolean;
  name: string;
  email: string;
  support: { bureauId: string; expiresAt: Date } | null;
};

async function revokeAndReject(
  userId: string,
  code: Exclude<SessionAccessError["code"], "session_required">,
): Promise<never> {
  await revokeUserSessions(userId);
  throw new SessionAccessError(code);
}

export async function getRequiredSessionFromHeaders(
  requestHeaders: Headers,
  now = Date.now(),
): Promise<RequiredSession> {
  const current = await auth.api.getSession({ headers: requestHeaders });
  if (!current) throw new SessionAccessError("session_required");

  const profile = await findAuthProfile(current.user.id);
  if (!profile) return revokeAndReject(current.user.id, "user_deactivated");
  if (!profile.isActive) return revokeAndReject(current.user.id, "user_deactivated");
  // O superadmin não pertence a um Bureau; o suporte a um Bureau inativo é permitido.
  if (profile.role !== "superadmin" && !profile.bureauActive) {
    return revokeAndReject(current.user.id, "bureau_inactive");
  }

  const createdAt = current.session.createdAt.getTime();
  const updatedAt = current.session.updatedAt.getTime();
  if (now - createdAt >= ABSOLUTE_SESSION_MS) {
    return revokeAndReject(current.user.id, "session_absolute_expired");
  }
  if (now - updatedAt >= IDLE_SESSION_MS) {
    return revokeAndReject(current.user.id, "session_idle_expired");
  }
  if (now - updatedAt >= ACTIVITY_WRITE_MS) {
    await pool.query(
      'update "session" set updated_at = now() where id = $1 and updated_at <= now() - interval \'5 minutes\'',
      [current.session.id],
    );
  }

  const mfaComplete = Boolean(current.user.twoFactorEnabled);
  if (profile.role !== "client" && !mfaComplete) {
    // Enrollment state, not a compromise: keep the session so the user can reach
    // /mfa/setup and enrol. Revoking here would lock every staff user out on day one.
    throw new SessionAccessError("mfa_setup_required");
  }

  const support = profile.role === "superadmin" ? profile.support : null;
  const supportSessionId = support?.sessionId ?? null;
  return {
    userId: profile.userId,
    role: profile.role,
    bureauId: support ? support.bureauId : profile.bureauId,
    supportSessionId,
    permissions: permissionsFor({ role: profile.role, supportSessionId }),
    mfaComplete,
    name: current.user.name,
    email: current.user.email,
    support: support ? { bureauId: support.bureauId, expiresAt: support.expiresAt } : null,
  };
}

export async function getRequiredSession(): Promise<RequiredSession> {
  return getRequiredSessionFromHeaders(new Headers(headers()));
}
