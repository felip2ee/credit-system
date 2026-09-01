"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { config } from "@/lib/config";
import { auth } from "@/lib/auth/server";
import {
  changeRoleAndRevokeSessions,
  deactivateUserAndRevokeSessions,
  revokeUserSessions,
} from "@/lib/auth/authorization";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { recordAudit } from "@/lib/audit";

export interface CreateConsultantResult {
  error: string | null;
  email?: string;
}

const roleSchema = z.enum(["consultant", "admin", "client"]);

async function requireUserManagement() {
  const session = await getRequiredSession();
  if (!hasPermission(session.role, "users:manage")) {
    throw new Error("administrator authorization is required");
  }
  return session;
}

export async function createConsultant(
  fullName: string,
  email: string,
  role: "consultant" | "admin" = "consultant",
): Promise<CreateConsultantResult> {
  const actor = await requireUserManagement();
  const safeRole = roleSchema.parse(role);
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = fullName.trim();
  if (cleanName.length < 3) return { error: "Nome muito curto." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return { error: "E-mail inválido." };
  }

  const userId = randomUUID();
  try {
    await withUserTransaction(actor, async (client) => {
      await client.query(
        'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
        [userId, cleanName, cleanEmail],
      );
      await client.query(
        "insert into profiles (id, auth_user_id, full_name, email, role) values ($1, $1, $2, $3, $4)",
        [userId, cleanName, cleanEmail, safeRole],
      );
    });
    await auth.api.requestPasswordReset({
      body: {
        email: cleanEmail,
        redirectTo: `${config.betterAuthUrl}/update-password`,
      },
    });
  } catch {
    return { error: "Falha ao enviar o convite." };
  }

  await recordAudit({
    action: "user.invite",
    tableName: "profiles",
    recordId: userId,
    data: { role: safeRole, email: cleanEmail },
  });
  revalidatePath("/settings/users");
  return { error: null, email: cleanEmail };
}

export async function setUserRole(
  userId: string,
  role: "consultant" | "admin" | "client",
): Promise<{ error: string | null }> {
  const actor = await requireUserManagement();
  const safeRole = roleSchema.parse(role);
  try {
    await changeRoleAndRevokeSessions(actor.userId, userId, safeRole);
  } catch {
    return { error: "Falha ao alterar o perfil." };
  }
  await recordAudit({
    action: "user.role_change",
    tableName: "profiles",
    recordId: userId,
    data: { role: safeRole },
  });
  revalidatePath("/settings/users");
  return { error: null };
}

export async function setUserActive(
  userId: string,
  isActive: boolean,
): Promise<{ error: string | null }> {
  const actor = await requireUserManagement();
  try {
    if (!isActive) {
      await deactivateUserAndRevokeSessions(actor.userId, userId);
    } else {
      await withUserTransaction(actor, async (client) => {
        const result = await client.query(
          "update profiles set is_active = true, updated_at = now() where id = $1",
          [userId],
        );
        if (result.rowCount !== 1) throw new Error("profile not found");
        await revokeUserSessions(userId);
      });
    }
  } catch {
    return { error: "Falha ao alterar o usuário." };
  }
  await recordAudit({
    action: isActive ? "user.activate" : "user.deactivate",
    tableName: "profiles",
    recordId: userId,
  });
  revalidatePath("/settings/users");
  return { error: null };
}
