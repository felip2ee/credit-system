import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/app";

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, avatar_url, is_active, mfa_enabled")
    .eq("id", user.id)
    .single();

  return (data as Profile | null) ?? null;
}

export async function isAdmin(): Promise<boolean> {
  const profile = await getCurrentProfile();
  return profile?.role === "admin";
}
