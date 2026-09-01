import { getRequiredSession } from "@/lib/auth/session";
import type { Profile } from "@/types/app";

export async function getCurrentProfile(): Promise<Profile | null> {
  try {
    const session = await getRequiredSession();

    return {
      id: session.userId,
      full_name: session.name,
      email: session.email,
      role: session.role,
      avatar_url: null,
      is_active: true,
      mfa_enabled: session.mfaComplete,
    };
  } catch {
    return null;
  }
}

export async function isAdmin(): Promise<boolean> {
  return (await getCurrentProfile())?.role === "admin";
}
