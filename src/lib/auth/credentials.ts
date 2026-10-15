// Senha temporária definida por um administrador e limpeza da flag must_change_password.
// A senha em texto puro só entra em hashPassword; o SQL e a auditoria nunca a recebem.
import { hashPassword } from "better-auth/crypto";
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction } from "@/lib/db/transaction";

import { findAuthProfile } from "./authorization";

export type CredentialsInput = { targetId: string; bureauId: string; password: string | null };
export type CredentialsOutcome = { ok: true } | { ok: false; reason: "not_found" };

// `password` nulo só liga a flag ("forçar troca"). O gateway SQL valida quem chama e o alvo
// e apaga as sessões do alvo; ele lança 42501 se o chamador não for administrador.
export async function setTemporaryCredentials(
  client: PoolClient,
  actorId: string,
  input: CredentialsInput,
): Promise<CredentialsOutcome> {
  const passwordHash = input.password === null ? null : await hashPassword(input.password);
  const { rows } = await client.query<{ ok: boolean }>(
    "select public.admin_set_credentials($1::uuid, $2::uuid, $3::text) as ok",
    [input.targetId, input.bureauId, passwordHash],
  );
  if (!rows[0]?.ok) return { ok: false, reason: "not_found" };
  await writeAuditEvent(client, {
    actorId,
    action: passwordHash === null ? "user.force_password_change" : "user.password_set",
    targetTable: "profiles",
    targetId: input.targetId,
  });
  return { ok: true };
}

// Chamado depois que o próprio usuário troca a senha (hook do Better Auth). Erro propaga.
export async function clearMustChangePassword(authUserId: string): Promise<void> {
  const profile = await findAuthProfile(authUserId);
  if (!profile) return;
  await withUserTransaction(
    { userId: profile.userId, role: profile.role, bureauId: profile.bureauId },
    async (client) => {
      const { rowCount } = await client.query(
        "update profiles set must_change_password = false where id = $1 and must_change_password",
        [profile.userId],
      );
      if (rowCount !== 1) return;
      await writeAuditEvent(client, {
        actorId: profile.userId,
        action: "user.password_changed",
        targetTable: "profiles",
        targetId: profile.userId,
      });
    },
  );
}
