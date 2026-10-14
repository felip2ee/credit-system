// Convite de usuário: cria user + profile + auditoria no cliente da transação do chamador.
// O e-mail sai só depois do commit (sendInviteEmail); o reenvio é seguro (idempotente).
import { hashPassword } from "better-auth/crypto";
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { config } from "@/lib/config";

import { auth } from "./server";

// Os chamadores já validam a entrada com zod (users.ts, validators/bureau, portal.ts).
export type InviteInput = {
  email: string;
  fullName: string;
  role: "bureau_admin" | "operator" | "client";
  bureauId: string;
  // Senha temporária: cria o usuário já com conta e must_change_password, sem e-mail.
  password?: string;
};

export type InviteOutcome =
  | { ok: true; userId: string; resent: boolean; reactivated?: true }
  | { ok: false; reason: "email_in_use" | "already_member" };

type ExistingUser = {
  id: string;
  role: string | null;
  bureauId: string | null;
  hasAccount: boolean;
  isActive: boolean | null;
};

export async function createInvite(
  client: PoolClient,
  actorId: string,
  input: InviteInput,
): Promise<InviteOutcome> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  // O RLS só mostra perfis do Bureau do chamador: perfil invisível equivale a "sem perfil".
  const { rows } = await client.query<ExistingUser>(
    `select u.id, p.role::text as role, p.bureau_id as "bureauId", p.is_active as "isActive",
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
    // Com senha, só cria conta nova; convite pendente usa "Definir senha".
    if (passwordHash) return { ok: false, reason: "already_member" };
    // Cliente revogado volta pelo convite do Titular; equipe desativada volta só por setUserActive.
    if (input.role === "client" && existing.isActive === false) {
      await client.query("update profiles set is_active = true, updated_at = now() where id = $1", [existing.id]);
      return { ok: true, userId: existing.id, resent: true, reactivated: true };
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
  if (passwordHash) {
    await client.query(
      `insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at)
       values (gen_random_uuid()::text, 'local:credential', $1, 'credential', $1, $2, now())`,
      [userId, passwordHash],
    );
  }
  await client.query(
    `insert into profiles (id, auth_user_id, full_name, email, role, bureau_id, must_change_password)
     values ($1::uuid, $1::text, $2, $3, $4::user_role, $5, $6)`,
    [userId, fullName, email, input.role, input.bureauId, passwordHash !== null],
  );
  await writeAuditEvent(client, {
    actorId,
    action: passwordHash ? "user.create_with_password" : "user.invite",
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
