import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { pool } from "@/lib/db/pool";
import { enqueueNotification, type EnqueueFailure } from "@/lib/notifications/queries";
import { toE164 } from "@/lib/notifications/recipient";
import type { EntityKind, ScrAuthorization, ScrStatus } from "@/types/app";

export async function markScrPending(identity: DbIdentity, id: string, email?: string | null): Promise<void> {
  await withUserTransaction(identity, (client) => client.query(
    `update scr_authorizations set status='pending', requested_at=now(), last_checked_at=now(),
     email=coalesce($2,email) where id=$1`, [id, email ?? null]));
}

export async function listScrAuthorizations(identity: DbIdentity, status?: ScrStatus): Promise<ScrAuthorization[]> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<ScrAuthorization>(
      `select s.id,s.document,s.type,s.name,s.email,s.holder_id,s.consultation_id,s.status::text,s.requested_at::text,s.authorized_at::text,
       s.expires_at::text,s.last_checked_at::text,n.status as "lastNotificationStatus" from scr_authorizations s
       left join lateral (select status from notifications
         where reference = 'scr_authorization:' || s.id::text order by created_at desc, id desc limit 1) n on true
       where ($1::text is null or s.status::text=$1) order by s.requested_at desc limit 200`, [status ?? null]);
    return rows;
  });
}

export interface PublicScrAuthorization {
  status: ScrStatus; type: EntityKind; consentText: string; clientName: string;
  document: string; expiresAt: string | null;
}

// Public confirmation has no authenticated identity. The single conditional UPDATE
// is deliberately fail-closed: a used or expired token cannot be replayed.
export async function getPublicScrAuthorization(token: string): Promise<PublicScrAuthorization | null> {
  const { rows } = await pool.query<{
    status: ScrStatus; type: EntityKind; consent_text: string | null; consent_name: string | null;
    consent_document: string | null; expires_at: string | null;
  }>(`select status, type, consent_text, consent_name, consent_document, expires_at::text
      from public.public_scr_authorization($1, $2)`, [token, "internal"]);
  const row = rows[0];
  return row ? { status: row.status, type: row.type, consentText: row.consent_text ?? "", clientName: row.consent_name ?? "", document: row.consent_document ?? "", expiresAt: row.expires_at } : null;
}

export async function resolveScrContact(identity: DbIdentity, id: string) {
  return withUserTransaction(identity, async (client) => {
    // D14: o e-mail do titular que se cadastrou sozinho (created_by = o próprio cliente) não é endereço para enviar o código.
    const { rows } = await client.query<{ id: string; document: string; type: EntityKind; name: string | null; email: string | null; phone_e164: string | null; holder_id: string; holder_name: string | null; holder_email: string | null }>(
      `select s.id,s.document,s.type,s.name,s.email,s.phone_e164,s.holder_id,h.name holder_name,
       case when h.created_by = h.client_profile_id then null else h.email end holder_email
       from scr_authorizations s left join holders h on h.id=s.holder_id where s.id=$1`, [id]);
    return rows[0] ?? null;
  });
}

export type IssueSelfScrResult = { ok: true } | { ok: false; reason: "not_found" | EnqueueFailure };

// ScrIssueIsAtomic: o erro derruba a transação, então o auth_code antigo continua valendo.
class ScrEnqueueError extends Error {
  constructor(readonly reason: EnqueueFailure) { super(`scr_authorization enqueue failed: ${reason}`); }
}

export async function issueSelfScrAuthorization(
  identity: DbIdentity,
  id: string,
  input: {
    code: string; email: string; consentText: string; consentName: string; consentDocument: string;
    notification: { recipient: string; clientName: string; authorizedName: string; siteUrl: string; phone?: string | null };
  },
): Promise<IssueSelfScrResult> {
  const phone = input.notification.phone ? toE164(input.notification.phone) : null;
  if (input.notification.phone && !phone) return { ok: false, reason: "invalid_recipient" };
  try {
    return await withUserTransaction(identity, async (client): Promise<IssueSelfScrResult> => {
      const { rows } = await client.query<{ public_token: string; requested_at: string }>(
        `update scr_authorizations set channel='internal', auth_code=$2, email=$3,
         consent_text=$4,consent_name=$5,consent_document=$6,status='pending',requested_at=now(),
         last_checked_at=now(),authorized_at=null,consented_at=null,refused_at=null,
         request_expires_at=now() + interval '7 days',phone_e164=coalesce($7,phone_e164)
         where id=$1 returning public_token::text,requested_at::text`,
        [id, input.code, input.email, input.consentText, input.consentName, input.consentDocument, phone]);
      const row = rows[0];
      if (!row) return { ok: false, reason: "not_found" };
      // Reemissão: o e-mail antigo ainda na fila traria um código que já não vale.
      await client.query("select supersede_notifications($1, $2)", ["scr_authorization", `scr_authorization:${id}`]);
      const { recipient, clientName, authorizedName, siteUrl } = input.notification;
      const params = { clientName, authorizedName, code: input.code, url: `${siteUrl}/autorizacao-scr/${row.public_token}` };
      const base = `${id}:${row.requested_at}`;
      const messages = [
        { channel: "email" as const, to: recipient, idempotencyKey: `scr_authorization:${base}` },
        ...(phone ? [{ channel: "whatsapp" as const, to: phone, idempotencyKey: `scr_authorization:whatsapp:${base}` }] : []),
      ];
      for (const { channel, to, idempotencyKey } of messages) {
        const queued = await enqueueNotification(client, identity, {
          templateKey: "scr_authorization",
          channel,
          recipient: to,
          params,
          idempotencyKey,
          reference: `scr_authorization:${id}`,
        });
        if (!queued.ok) throw new ScrEnqueueError(queued.reason);
      }
      return { ok: true };
    });
  } catch (error) {
    if (error instanceof ScrEnqueueError) return { ok: false, reason: error.reason };
    throw error;
  }
}

export async function confirmPublicScrAuthorization(token: string, code: string, decision: "authorize" | "refuse", ip: string | null) {
  const { rows } = await pool.query<{
    result: "authorized" | "refused" | "invalid_code" | "not_found" | "already" | "expired";
  }>(
    "select public.confirm_public_scr_authorization($1, $2, $3, $4, $5) as result",
    [token, "internal", code, decision, ip],
  );
  return { status: rows[0]?.result ?? "not_found" };
}
