"use server";

import { revalidatePath } from "next/cache";

import { writeAuditEvent } from "@/lib/audit/write";
import { createInvite, sendInviteEmail } from "@/lib/auth/invite";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";

export interface ActionResult {
  error: string | null;
  id?: string;
}

async function requireStaff(): Promise<RequiredSession> {
  const session = await getRequiredSession();
  if (!hasPermission(session, "users:manage")) throw new Error("forbidden");
  return session;
}

type PortalHolder = { id: string; name: string; email: string | null; client_profile_id: string | null };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// portal.invite: convite com papel `client` no Bureau do chamador; liga o Titular ao perfil na mesma transação.
export async function inviteHolderToPortal(holderId: string): Promise<ActionResult> {
  let actor: RequiredSession;
  try {
    actor = await requireStaff();
  } catch {
    return { error: "Apenas a equipe pode conceder acesso ao portal." };
  }
  const bureauId = actor.bureauId;
  if (!bureauId) return { error: "Não foi possível criar o acesso." };

  let email: string | undefined;
  let userId: string | undefined;
  try {
    await withUserTransaction(actor, async (client) => {
      const found = await client.query<PortalHolder>(
        "select id, name, email, client_profile_id from holders where id = $1 for update",
        [holderId],
      );
      const holder = found.rows[0];
      if (!holder) throw new Error("holder_not_found");
      // Convite ainda sem conta (e-mail falhou, por exemplo) segue o caminho seguro de reenvio.
      if (holder.client_profile_id) {
        const accepted = await client.query(
          "select 1 from account where user_id = $1::text",
          [holder.client_profile_id],
        );
        if (accepted.rows[0]) throw new Error("already_invited");
      }
      email = holder.email?.trim().toLowerCase();
      if (!email || !EMAIL_PATTERN.test(email)) throw new Error("invalid_email");

      const invite = await createInvite(client, actor.userId, {
        email,
        fullName: holder.name,
        role: "client",
        bureauId,
      });
      if (!invite.ok) throw new Error(invite.reason);
      userId = invite.userId;

      await client.query("update holders set client_profile_id = $2 where id = $1", [holderId, userId]);
      await writeAuditEvent(client, {
        actorId: actor.userId,
        action: invite.reactivated ? "portal.reinvite" : "portal.invite",
        targetTable: "holders",
        targetId: holderId,
        metadata: { email },
      });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "holder_not_found") return { error: "Titular não encontrado." };
    if (reason === "already_invited") return { error: "Este Titular já tem acesso ao portal. Revogue antes de reenviar." };
    if (reason === "invalid_email") return { error: "Cadastre um e-mail válido no Titular antes de convidar." };
    if (reason === "email_in_use") return { error: "Este e-mail já pertence a outra conta." };
    if (reason === "already_member") return { error: "Este e-mail já tem acesso ao portal." };
    return { error: "Não foi possível criar o acesso." };
  }

  if (!email || !userId) return { error: "Não foi possível criar o acesso." };
  // O vínculo já foi gravado: revalida mesmo se o e-mail falhar; novo convite reenvia.
  revalidatePath(`/holders/${holderId}`);
  if (!(await sendInviteEmail(email)))
    return { error: "Acesso criado, mas o link para definir a senha falhou. Tente convidar de novo." };
  return { error: null, id: userId };
}

export async function revokeHolderPortalAccess(holderId: string): Promise<ActionResult> {
  let actor: RequiredSession;
  try {
    actor = await requireStaff();
  } catch {
    return { error: "Apenas a equipe pode revogar o acesso ao portal." };
  }
  try {
    await withUserTransaction(actor, async (client) => {
      const found = await client.query<{ client_profile_id: string | null }>(
        "select client_profile_id from holders where id = $1 for update",
        [holderId],
      );
      if (!found.rows[0]) throw new Error("holder_not_found");
      const userId = found.rows[0].client_profile_id;
      if (!userId) throw new Error("not_active");
      await client.query("update holders set client_profile_id = null where id = $1", [holderId]);
      await client.query("update profiles set is_active = false, updated_at = now() where id = $1", [userId]);
      await client.query('delete from "session" where user_id = $1', [userId]);
      await writeAuditEvent(client, { actorId: actor.userId, action: "portal.revoke", targetTable: "holders", targetId: holderId, metadata: { user_id: userId } });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "holder_not_found") return { error: "Titular não encontrado." };
    if (reason === "not_active") return { error: "Este Titular não tem acesso ativo." };
    return { error: "Não foi possível revogar o acesso." };
  }
  revalidatePath(`/holders/${holderId}`);
  return { error: null };
}
