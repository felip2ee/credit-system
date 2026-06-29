"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export interface SignInResult {
  error: string | null;
}

export async function signIn(
  email: string,
  password: string
): Promise<SignInResult> {
  const supabase = createClient();

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: "E-mail ou senha inválidos." };
  }

  redirect("/");
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
