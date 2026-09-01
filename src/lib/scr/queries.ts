import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { pool } from "@/lib/db/pool";
import type { EntityKind, ScrAuthorization, ScrStatus } from "@/types/app";

export interface ScrAuthUpsert {
  document: string;
  type: EntityKind;
  status: ScrStatus;
  name?: string | null;
  email?: string | null;
  queryId?: string | null;
  crmClientId?: string | null;
  requestedBy?: string | null;
}

export function isUsableScrAuthorization(
  status: ScrStatus,
  expiresAt: string | null,
  now = new Date(),
): boolean {
  return status === "authorized" && (!expiresAt || new Date(expiresAt) > now);
}

export async function hasValidInternalScr(identity: DbIdentity, document: string): Promise<boolean> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ status: ScrStatus; expires_at: string | null }>(
      `select status::text, expires_at::text from scr_authorizations
       where document = $1 and channel = 'internal'
       order by requested_at desc limit 1`,
      [document],
    );
    const row = rows[0];
    return !!row && isUsableScrAuthorization(row.status, row.expires_at);
  });
}

export async function upsertScrAuthorization(identity: DbIdentity, input: ScrAuthUpsert): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    const current = await client.query<{ id: string }>(
      `select id from scr_authorizations where document = $1
       order by requested_at desc limit 1 for update`, [input.document],
    );
    const authorized = input.status === "authorized";
    if (current.rows[0]) {
      await client.query(
        `update scr_authorizations set status=$2, type=$3, name=$4,
         email=coalesce($5,email), crm_client_id=coalesce($6,crm_client_id),
         consultation_id=$7, last_checked_at=now(),
         authorized_at=case when $8 then now() else authorized_at end,
         requested_at=case when $8 then requested_at else now() end
         where id=$1`,
        [current.rows[0].id, input.status, input.type, input.name ?? null, input.email ?? null, input.crmClientId ?? null, input.queryId ?? null, authorized],
      );
      return;
    }
    await client.query(
      `insert into scr_authorizations
       (document,type,name,email,consultation_id,crm_client_id,status,requested_by,authorized_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,case when $7='authorized' then now() end)`,
      [input.document, input.type, input.name ?? null, input.email ?? null, input.queryId ?? null, input.crmClientId ?? null, input.status, input.requestedBy ?? identity.userId],
    );
  });
}

export async function getScrAuthorization(identity: DbIdentity, id: string) {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{
      id: string; document: string; type: EntityKind; name: string | null; email: string | null;
      consultation_id: string | null; crm_client_id: string | null; status: ScrStatus;
    }>(`select id,document,type,name,email,consultation_id,crm_client_id,status::text
        from scr_authorizations where id=$1`, [id]);
    return rows[0] ?? null;
  });
}

export async function getScrByConsultation(identity: DbIdentity, consultationId: string) {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ id: string; document: string }>(
      `select id, document from scr_authorizations where consultation_id=$1
       order by requested_at desc limit 1`, [consultationId]);
    return rows[0] ?? null;
  });
}

export async function markScrPending(identity: DbIdentity, id: string, email?: string | null): Promise<void> {
  await withUserTransaction(identity, (client) => client.query(
    `update scr_authorizations set status='pending', requested_at=now(), last_checked_at=now(),
     email=coalesce($2,email) where id=$1`, [id, email ?? null]));
}

export async function authorizeScr(identity: DbIdentity, input: { id: string; validityDays: number; consultationId?: string | null; crmClientId?: string | null; document?: string }) {
  await withUserTransaction(identity, async (client) => {
    await client.query(
      `update scr_authorizations set status='authorized',authorized_at=now(),
       expires_at=now()+($2::text||' days')::interval,last_checked_at=now() where id=$1`,
      [input.id, input.validityDays],
    );
    if (input.crmClientId && input.document) await client.query(
      `insert into timeline_events (entity_type,entity_id,event_type,title,description,created_by)
       values ('crm_client',$1,'scr.authorized','Autoriza\u00e7\u00e3o SCR confirmada',$2,$3)`,
      [input.crmClientId, `Documento ${input.document}`, identity.userId],
    );
  });
}

export async function listScrAuthorizations(identity: DbIdentity, status?: ScrStatus): Promise<ScrAuthorization[]> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<ScrAuthorization>(
      `select id,document,type,name,email,status::text,requested_at::text,authorized_at::text,
       expires_at::text,last_checked_at::text from scr_authorizations
       where ($1::text is null or status::text=$1) order by requested_at desc limit 200`, [status ?? null]);
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
    const { rows } = await client.query<{ id: string; document: string; type: EntityKind; name: string | null; email: string | null; crm_client_id: string | null; client_name: string | null; client_email: string | null }>(
      `select s.id,s.document,s.type,s.name,s.email,s.crm_client_id,c.name client_name,c.email client_email
       from scr_authorizations s left join crm_clients c on c.id=s.crm_client_id where s.id=$1`, [id]);
    return rows[0] ?? null;
  });
}

export async function issueSelfScrAuthorization(identity: DbIdentity, id: string, input: { code: string; email: string; consentText: string; consentName: string; consentDocument: string }) {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ public_token: string; crm_client_id: string | null }>(
      `update scr_authorizations set channel='internal', auth_code=$2, email=$3,
       consent_text=$4,consent_name=$5,consent_document=$6,status='pending',requested_at=now(),
       last_checked_at=now(),authorized_at=null,consented_at=null,refused_at=null
       where id=$1 returning public_token::text,crm_client_id`,
      [id, input.code, input.email, input.consentText, input.consentName, input.consentDocument]);
    return rows[0] ?? null;
  });
}

export async function confirmPublicScrAuthorization(token: string, code: string, decision: "authorize" | "refuse", ip: string | null) {
  const { rows } = await pool.query<{
    result: "authorized" | "refused" | "invalid_code" | "not_found" | "already";
  }>(
    "select public.confirm_public_scr_authorization($1, $2, $3, $4, $5) as result",
    [token, "internal", code, decision, ip],
  );
  return { status: rows[0]?.result ?? "not_found" };
}
