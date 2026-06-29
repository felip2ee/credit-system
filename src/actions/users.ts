"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth";

function generateTempPassword(): string {
  return "Rk" + randomBytes(9).toString("base64url") + "#7";
}

export interface CreateConsultantResult {
  error: string | null;
  email?: string;
  tempPassword?: string;
}

export async function createConsultant(
  fullName: string,
  email: string,
  role: "consultant" | "admin" = "consultant"
): Promise<CreateConsultantResult> {
  if (!(await isAdmin())) {
    return { error: "Apenas administradores podem criar usuários." };
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = fullName.trim();
  if (cleanName.length < 3) return { error: "Nome muito curto." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail))
    return { error: "E-mail inválido." };

  const admin = createAdminClient();
  const tempPassword = generateTempPassword();

  const { data, error } = await admin.auth.admin.createUser({
    email: cleanEmail,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name: cleanName, role },
  });

  if (error || !data.user) {
    return { error: error?.message ?? "Falha ao criar usuário." };
  }

  // O trigger handle_new_user cria o profile; garantimos role/nome de forma idempotente.
  await admin
    .from("profiles")
    .update({ role, full_name: cleanName })
    .eq("id", data.user.id);

  revalidatePath("/settings/users");
  return { error: null, email: cleanEmail, tempPassword };
}

export async function setUserActive(
  userId: string,
  isActive: boolean
): Promise<{ error: string | null }> {
  if (!(await isAdmin())) {
    return { error: "Apenas administradores podem alterar usuários." };
  }

  const admin = createAdminClient();

  const { error: profileError } = await admin
    .from("profiles")
    .update({ is_active: isActive })
    .eq("id", userId);

  if (profileError) return { error: profileError.message };

  // Bane/desbane o login no Auth para refletir o status.
  await admin.auth.admin.updateUserById(userId, {
    ban_duration: isActive ? "none" : "876000h",
  });

  revalidatePath("/settings/users");
  return { error: null };
}
