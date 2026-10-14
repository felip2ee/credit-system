// Convite de usuário: cria user + profile + auditoria no cliente da transação do chamador.
// O e-mail sai só depois do commit (sendInviteEmail); o reenvio é seguro (idempotente).
import type { PoolClient } from "pg";
import { z } from "zod";

import { writeAuditEvent } from "@/lib/audit/write";
import { config } from "@/lib/config";

import { auth } from "./server";

export const inviteInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(3),
  role: z.enum(["bureau_admin", "operator", "client"]),
  bureauId: z.string().uuid(),
});

export type InviteInput = z.infer<typeof inviteInputSchema>;

export type InviteOutcome =
  | { ok: true; userId: string; resent: boolean }
  | { ok: false; reason: "email_in_use" | "already_member" };

type ExistingUser = {
  id: string;
  role: string | null;
  bureauId: string | null;
  hasAccount: boolean;
};

export async function createInvite(
  client: PoolClient,
  actorId: string,
  input: InviteInput,
): Promise<InviteOutcome> {
  const email = input.email.trim().toLowerCase();

  // O RLS só mostra perfis do Bureau do chamador: perfil invisível equivale a "sem perfil".
  const { rows } = await client.query<ExistingUser>(
    `select u.id, p.role::text as role, p.bureau_id as "bureauId",
            exists (select 1 from account a where a.user_id = u.id) as "hasAccount"
       from "user" u
       left join profiles p on p.auth_user_id = u.id
      where lower(u.email) = $1`,
    [email],
  );
  const existing = rows[0];

  if (existing) {
    if (existing.role !== input.role || existing.bureauId !== input.bureauId) {
      return { ok: false, reason: "email_in_use" };
    }
    if (existing.hasAccount) return { ok: false, reason: "already_member" };
    return { ok: true, userId: existing.id, resent: true };
  }

  const fullName = input.fullName.trim();
  const inserted = await client.query<{ id: string }>(
    `insert into "user" (id, name, email, email_verified)
     values (gen_random_uuid()::text, $1, $2, true)
     on conflict ((lower(email))) do nothing
     returning id`,
    [fullName, email],
  );
  // Outra transação criou o mesmo e-mail entre a leitura e o insert.
  if (!inserted.rows[0]) return { ok: false, reason: "email_in_use" };

  const userId = inserted.rows[0].id;
  await client.query(
    `insert into profiles (id, auth_user_id, full_name, email, role, bureau_id)
     values ($1::uuid, $1::text, $2, $3, $4::user_role, $5)`,
    [userId, fullName, email, input.role, input.bureauId],
  );
  await writeAuditEvent(client, {
    actorId,
    action: "user.invite",
    targetTable: "profiles",
    targetId: userId,
    metadata: { role: input.role, email },
  });
  return { ok: true, userId, resent: false };
}

export async function sendInviteEmail(email: string): Promise<boolean> {
  try {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${config.betterAuthUrl}/update-password` },
    });
    return true;
  } catch {
    return false;
  }
}
