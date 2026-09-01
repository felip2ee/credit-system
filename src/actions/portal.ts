"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { writeAuditEvent } from "@/lib/audit/write";
import { auth } from "@/lib/auth/server";
import { getRequiredSession } from "@/lib/auth/session";
import { config } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { DocumentRejectedError, storeDocument } from "@/lib/documents/service";
import { recordScannedDocumentUpload } from "@/lib/opportunities/queries";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface ActionResult {
  error: string | null;
  id?: string;
}

export interface SignedUrlResult {
  error: string | null;
  url?: string;
}

async function requireStaff(): Promise<DbIdentity> {
  const session = await getRequiredSession();
  if (!hasPermission(session.role, "clients:write")) throw new Error("forbidden");
  return session;
}

async function requirePortalClient(): Promise<DbIdentity> {
  const session = await getRequiredSession();
  if (session.role !== "client" || !hasPermission(session.role, "portal:write")) {
    throw new Error("forbidden");
  }
  return session;
}

type PortalClient = { id: string; name: string; email: string | null; user_id: string | null };

export async function inviteClientToPortal(crmClientId: string): Promise<ActionResult> {
  let actor: DbIdentity;
  try {
    actor = await requireStaff();
  } catch {
    return { error: "Apenas a equipe pode conceder acesso ao portal." };
  }

  let invited: PortalClient | undefined;
  let userId: string | undefined;
  try {
    await withUserTransaction(actor, async (client) => {
      const found = await client.query<PortalClient>(
        "select id, name, email, user_id from crm_clients where id = $1 for update",
        [crmClientId],
      );
      invited = found.rows[0];
      if (!invited) throw new Error("client_not_found");
      if (invited.user_id) throw new Error("already_invited");

      const email = invited.email?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new Error("invalid_email");
      }
      const existing = await client.query<{ id: string }>(
        'select id from "user" where lower(email) = $1 limit 1',
        [email],
      );
      userId = existing.rows[0]?.id ?? randomUUID();
      if (existing.rows[0]) {
        await client.query('update "user" set name = $2, updated_at = now() where id = $1', [userId, invited.name]);
      } else {
        await client.query('insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)', [userId, invited.name, email]);
      }
      await client.query(
        `insert into profiles (id, auth_user_id, full_name, email, role, is_active)
         values ($1, $1, $2, $3, 'client', true)
         on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, role = 'client', is_active = true`,
        [userId, invited.name, email],
      );
      await client.query("update crm_clients set user_id = $2 where id = $1", [crmClientId, userId]);
      await writeAuditEvent(client, {
        actorId: actor.userId,
        action: "portal.invite",
        targetTable: "crm_clients",
        targetId: crmClientId,
        metadata: { email },
      });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "client_not_found") return { error: "Cliente nÃ£o encontrado." };
    if (reason === "already_invited") return { error: "Este cliente jÃ¡ tem acesso ao portal. Revogue antes de reenviar." };
    if (reason === "invalid_email") return { error: "Cadastre um e-mail vÃ¡lido no cliente antes de convidar." };
    return { error: "NÃ£o foi possÃ­vel criar o acesso." };
  }

  const email = invited?.email?.trim().toLowerCase();
  if (!invited || !email || !userId) return { error: "NÃ£o foi possÃ­vel criar o acesso." };
  try {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${config.betterAuthUrl}/update-password` },
    });
  } catch {
    return { error: "Acesso criado, mas o link para definir a senha falhou." };
  }
  revalidatePath(`/clients/${crmClientId}`);
  return { error: null, id: userId };
}

export async function revokeClientPortalAccess(crmClientId: string): Promise<ActionResult> {
  let actor: DbIdentity;
  try {
    actor = await requireStaff();
  } catch {
    return { error: "Apenas a equipe pode revogar o acesso ao portal." };
  }
  try {
    await withUserTransaction(actor, async (client) => {
      const found = await client.query<{ user_id: string | null }>("select user_id from crm_clients where id = $1 for update", [crmClientId]);
      if (!found.rows[0]) throw new Error("client_not_found");
      const userId = found.rows[0].user_id;
      if (!userId) throw new Error("not_active");
      await client.query("update crm_clients set user_id = null where id = $1", [crmClientId]);
      await client.query("update profiles set is_active = false, updated_at = now() where id = $1", [userId]);
      await client.query('delete from "session" where user_id = $1', [userId]);
      await writeAuditEvent(client, { actorId: actor.userId, action: "portal.revoke", targetTable: "crm_clients", targetId: crmClientId, metadata: { user_id: userId } });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "client_not_found") return { error: "Cliente nÃ£o encontrado." };
    if (reason === "not_active") return { error: "Este cliente nÃ£o tem acesso ativo." };
    return { error: "NÃ£o foi possÃ­vel revogar o acesso." };
  }
  revalidatePath(`/clients/${crmClientId}`);
  return { error: null };
}

type OwnedDocument = { id: string; opportunity_id: string; label: string; status: string; file_path: string | null; scan_result: string | null; crm_client_id: string };

async function ownedDocument(docId: string, identity: DbIdentity): Promise<OwnedDocument | null> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<OwnedDocument>(
      `select d.id, d.opportunity_id, d.label, d.status, d.file_path, d.scan_result, o.crm_client_id
         from opportunity_documents d
         join opportunities o on o.id = d.opportunity_id
        where d.id = $1`,
      [docId],
    );
    return rows[0] ?? null;
  });
}

export async function uploadPortalDocument(formData: FormData): Promise<ActionResult> {
  let identity: DbIdentity;
  try {
    identity = await requirePortalClient();
  } catch {
    return { error: "SessÃ£o expirada." };
  }
  const docId = String(formData.get("docId") ?? "");
  const file = formData.get("file");
  if (!docId || !(file instanceof File) || file.size === 0) return { error: "Selecione um arquivo vÃ¡lido." };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Arquivo muito grande (mÃ¡ximo 15 MB)." };
  const doc = await ownedDocument(docId, identity).catch(() => null);
  if (!doc) return { error: "VocÃª nÃ£o tem acesso a este documento." };
  if (doc.status === "approved") return { error: "Este documento jÃ¡ foi aprovado e nÃ£o pode ser alterado." };
  try {
    await storeDocument({ stream: file.stream() as unknown as AsyncIterable<Uint8Array>, declaredName: file.name, declaredMime: file.type || "application/octet-stream", uploaderId: identity.userId, identity, link: { opportunityId: doc.opportunity_id, docType: doc.label, docId: doc.id, docLabel: doc.label } });
    await recordScannedDocumentUpload(identity, doc.opportunity_id, doc.label, file.name);
  } catch (error) {
    return { error: error instanceof DocumentRejectedError ? error.message : "Falha ao processar o arquivo." };
  }
  revalidatePath(`/portal/oportunidades/${doc.opportunity_id}`);
  revalidatePath("/portal");
  return { error: null, id: doc.id };
}

export async function getPortalDocUrl(docId: string): Promise<SignedUrlResult> {
  let identity: DbIdentity;
  try {
    identity = await requirePortalClient();
  } catch {
    return { error: "SessÃ£o expirada." };
  }
  const doc = await ownedDocument(docId, identity).catch(() => null);
  if (!doc) return { error: "VocÃª nÃ£o tem acesso a este documento." };
  if (doc.scan_result !== "clean" || !doc.file_path) return { error: "Documento ainda nÃ£o enviado." };
  return { error: null, url: `/api/documents/${docId}` };
}
