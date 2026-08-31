import { headers } from "next/headers";

import { auth } from "@/lib/auth/server";
import { getRequiredSession } from "@/lib/auth/session";
import type { Profile } from "@/types/app";

export async function getCurrentProfile(): Promise<Profile | null> {
  try {
    const session = await getRequiredSession();
    const current = await auth.api.getSession({
      headers: new Headers(headers()),
    });
    if (!current || current.user.id !== session.userId) return null;

    return {
      id: session.userId,
      full_name: current.user.name,
      email: current.user.email,
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
