import { headers } from "next/headers";

import { auth } from "./server";
import { findAuthProfile, permissionsFor, revokeUserSessions, type AuthRole } from "./authorization";
import { pool } from "@/lib/db/pool";
import type { Permission } from "@/lib/db/permissions";

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
      | "user_deactivated",
  ) {
    super(code);
  }
}

export type RequiredSession = {
  userId: string;
  role: AuthRole;
  permissions: readonly Permission[];
  mfaComplete: boolean;
  name: string;
  email: string;
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
  if ((profile.role === "admin" || profile.role === "consultant") && !mfaComplete) {
    // Enrollment state, not a compromise: keep the session so the user can reach
    // /mfa/setup and enrol. Revoking here would lock every staff user out on day one.
    throw new SessionAccessError("mfa_setup_required");
  }

  return {
    userId: profile.userId,
    role: profile.role,
    permissions: permissionsFor(profile.role),
    mfaComplete,
    name: current.user.name,
    email: current.user.email,
  };
}

export async function getRequiredSession(): Promise<RequiredSession> {
  return getRequiredSessionFromHeaders(new Headers(headers()));
}
