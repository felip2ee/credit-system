// CRM client data access — parameterized SQL under Task 3 transaction/RLS
// boundaries. One small function per domain operation; no CRUD generator, no
// PoolClient escapes this module. Each mutation writes its audit event in the
// same transaction (see lib/audit/write.ts).
//
// Business conflicts that map to a user-facing message are returned as
// `{ ok: false, reason }`; anything else throws and rolls the transaction back.

import type { ClientInput } from "@/lib/validators/client";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { writeAuditEvent } from "@/lib/audit/write";
import type { CrmClient, CrmClientStatus } from "@/types/app";

export type CreateReason = "duplicate_document";
export type LinkPartnerReason = "self_link" | "already_linked";

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; reason: CreateReason };
export type LinkPartnerResult =
  | { ok: true; id: string }
  | { ok: false; reason: LinkPartnerReason };

const UNIQUE_VIOLATION = "23505";

export async function createClientRecord(
  identity: DbIdentity,
  data: ClientInput,
): Promise<CreateResult> {
  return withUserTransaction(identity, async (client) => {
    const dup = await client.query(
      "select 1 from crm_clients where document = $1 limit 1",
      [data.document],
    );
    if (dup.rowCount && dup.rowCount > 0) {
      return { ok: false, reason: "duplicate_document" };
    }

    const inserted = await client.query<{ id: string }>(
      `insert into crm_clients
         (type, name, document, email, phone, address, address_number,
          address_complement, neighborhood, city, state, zip_code, status,
          notes, created_by, assigned_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       returning id`,
      [
        data.type,
        data.name,
        data.document,
        data.email,
        data.phone,
        data.address,
        data.address_number,
        data.address_complement,
        data.neighborhood,
        data.city,
        data.state,
        data.zip_code,
        data.status,
        data.notes,
        identity.userId,
      ],
    );
    const id = inserted.rows[0].id;

    await client.query(
      `insert into crm_client_documents (client_id, type, document, label, is_primary)
       values ($1, $2, $3, $4, true)`,
      [id, data.type, data.document, data.type === "PJ" ? "CNPJ principal" : "CPF"],
    );

    await client.query(
      `insert into timeline_events
         (entity_type, entity_id, event_type, title, description, created_by)
       values ('crm_client', $1, 'client.created', 'Cliente cadastrado', $2, $3)`,
      [id, data.name, identity.userId],
    );

    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: "client.create",
      targetTable: "crm_clients",
      targetId: id,
      metadata: { type: data.type, name: data.name },
    });

    return { ok: true, id };
  });
}

export async function updateClientRecord(
  identity: DbIdentity,
  id: string,
  data: ClientInput,
): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    await client.query(
      `update crm_clients set
         name = $2, email = $3, phone = $4, address = $5, address_number = $6,
         address_complement = $7, neighborhood = $8, city = $9, state = $10,
         zip_code = $11, notes = $12, updated_at = now()
       where id = $1`,
      [
        id,
        data.name,
        data.email,
        data.phone,
        data.address,
        data.address_number,
        data.address_complement,
        data.neighborhood,
        data.city,
        data.state,
        data.zip_code,
        data.notes,
      ],
    );
    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: "client.update",
      targetTable: "crm_clients",
      targetId: id,
      metadata: { name: data.name },
    });
  });
}

export async function updateClientStatus(
  identity: DbIdentity,
  id: string,
  status: CrmClientStatus,
): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    await client.query(
      "update crm_clients set status = $2, updated_at = now() where id = $1",
      [id, status],
    );
    await client.query(
      `insert into timeline_events
         (entity_type, entity_id, event_type, title, metadata, created_by)
       values ('crm_client', $1, 'client.status_changed', 'Status alterado', $2::jsonb, $3)`,
      [id, JSON.stringify({ to: status }), identity.userId],
    );
    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: "client.status_change",
      targetTable: "crm_clients",
      targetId: id,
      metadata: { to: status },
    });
  });
}

export async function addClientNote(
  identity: DbIdentity,
  clientId: string,
  content: string,
): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    await client.query(
      `insert into crm_notes (entity_type, entity_id, content, created_by)
       values ('crm_client', $1, $2, $3)`,
      [clientId, content, identity.userId],
    );
    await client.query(
      `insert into timeline_events
         (entity_type, entity_id, event_type, title, description, created_by)
       values ('crm_client', $1, 'note.added', 'Anotação adicionada', $2, $3)`,
      [clientId, content.slice(0, 140), identity.userId],
    );
    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: "client.note_add",
      targetTable: "crm_notes",
      targetId: clientId,
    });
  });
}

export interface LinkPartnerData {
  document: string; // digits only
  name: string;
  percentage: number | null;
  role: string | null;
}

export async function linkPartner(
  identity: DbIdentity,
  pjClientId: string,
  data: LinkPartnerData,
): Promise<LinkPartnerResult> {
  return withUserTransaction(identity, async (client) => {
    const existing = await client.query<{ id: string }>(
      "select id from crm_clients where document = $1 limit 1",
      [data.document],
    );

    let partnerId: string;
    if (existing.rowCount && existing.rowCount > 0) {
      partnerId = existing.rows[0].id;
    } else {
      const createdPf = await client.query<{ id: string }>(
        `insert into crm_clients (type, name, document, status, created_by, assigned_to)
         values ('PF', $1, $2, 'prospect', $3, $3)
         returning id`,
        [data.name, data.document, identity.userId],
      );
      partnerId = createdPf.rows[0].id;
      await client.query(
        `insert into crm_client_documents (client_id, type, document, label, is_primary)
         values ($1, 'PF', $2, 'CPF', true)`,
        [partnerId, data.document],
      );
    }

    if (partnerId === pjClientId) return { ok: false, reason: "self_link" };

    try {
      await client.query(
        `insert into crm_client_relations
           (client_id, related_id, relation_type, percentage, role)
         values ($1, $2, 'socio', $3, $4)`,
        [pjClientId, partnerId, data.percentage, data.role],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return { ok: false, reason: "already_linked" };
      }
      throw error;
    }

    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: "client.partner_link",
      targetTable: "crm_client_relations",
      targetId: pjClientId,
      metadata: { partnerId, name: data.name },
    });

    return { ok: true, id: partnerId };
  });
}

// ── Reads (server components) ────────────────────────────────────────────

export interface ClientListItem {
  id: string;
  type: "PF" | "PJ";
  name: string;
  document: string | null;
  status: CrmClientStatus;
  city: string | null;
  state: string | null;
  updated_at: string;
}

export async function listClients(
  identity: DbIdentity,
  filters: { q?: string; type?: string; status?: string },
): Promise<ClientListItem[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.type === "PF" || filters.type === "PJ") {
    params.push(filters.type);
    where.push(`type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.q && filters.q.trim().length > 0) {
    const term = filters.q.trim();
    const digits = term.replace(/\D/g, "");
    params.push(`%${term}%`);
    const nameIdx = params.length;
    if (digits.length > 0) {
      params.push(`%${digits}%`);
      where.push(`(name ilike $${nameIdx} or document ilike $${params.length})`);
    } else {
      where.push(`name ilike $${nameIdx}`);
    }
  }
  const sql = `select id, type, name, document, status, city, state, updated_at::text
       from crm_clients
       ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
       order by updated_at desc
       limit 100`;
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<ClientListItem>(sql, params);
    return rows;
  });
}

export interface ClientDetailRow {
  id: string;
  type: "PF" | "PJ";
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  address_number: string | null;
  address_complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  status: CrmClientStatus;
  user_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientDetail {
  client: ClientDetailRow;
  relations: {
    client_id: string;
    related_id: string;
    percentage: number | null;
    role: string | null;
  }[];
  people: { id: string; name: string; document: string | null; type: "PF" | "PJ" }[];
  events: {
    id: string;
    entity_type: string;
    entity_id: string;
    event_type: string;
    title: string;
    description: string | null;
    metadata: Record<string, unknown> | null;
    created_by: string | null;
    created_at: string;
  }[];
  consultations: {
    id: string;
    type: "PF" | "PJ";
    document: string;
    document_name: string | null;
    product: string | null;
    status: string;
    consulted_at: string | null;
    created_at: string;
  }[];
  opportunities: {
    id: string;
    status: string;
    requested_amount: number | null;
    partner_name: string | null;
    created_at: string;
  }[];
}

export async function getClientDetail(
  identity: DbIdentity,
  id: string,
): Promise<ClientDetail | null> {
  return withUserTransaction(identity, async (client) => {
    const clientRow = await client.query<ClientDetailRow>(
      `select id, type, name, document, email, phone, address, address_number,
              address_complement, neighborhood, city, state, zip_code, status,
              user_id, notes, created_at::text, updated_at::text
         from crm_clients where id = $1`,
      [id],
    );
    if (clientRow.rowCount === 0) return null;

    const relations = await client.query<ClientDetail["relations"][number]>(
      `select client_id, related_id, percentage::float8 as percentage, role
         from crm_client_relations
        where relation_type = 'socio' and (client_id = $1 or related_id = $1)`,
      [id],
    );

    const referenced = Array.from(
      new Set(
        relations.rows.flatMap((r) =>
          r.client_id === id ? [r.related_id] : [r.client_id],
        ),
      ),
    );
    const people = referenced.length
      ? await client.query<ClientDetail["people"][number]>(
          `select id, name, document, type from crm_clients where id = any($1::uuid[])`,
          [referenced],
        )
      : { rows: [] as ClientDetail["people"] };

    const events = await client.query<ClientDetail["events"][number]>(
      `select id, entity_type::text, entity_id, event_type, title, description,
              metadata, created_by, created_at::text
         from timeline_events
        where entity_type = 'crm_client' and entity_id = $1
        order by created_at desc`,
      [id],
    );

    const consultations = await client.query<
      ClientDetail["consultations"][number]
    >(
      `select id, type, document, document_name, product, status::text,
              consulted_at::text, created_at::text
         from consultations
        where crm_client_id = $1
        order by created_at desc
        limit 50`,
      [id],
    );

    const opportunities = await client.query<
      ClientDetail["opportunities"][number]
    >(
      `select id, status, requested_amount::float8 as requested_amount,
              partner_name, created_at::text
         from opportunities
        where crm_client_id = $1
        order by created_at desc
        limit 50`,
      [id],
    );

    return {
      client: clientRow.rows[0],
      relations: relations.rows,
      people: people.rows,
      events: events.rows,
      consultations: consultations.rows,
      opportunities: opportunities.rows,
    };
  });
}

export async function getClientForEdit(
  identity: DbIdentity,
  id: string,
): Promise<CrmClient | null> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<CrmClient>(
      `select id, type, name, document, email, phone, address, address_number,
              address_complement, neighborhood, city, state, zip_code, status,
              assigned_to, user_id, notes, created_by,
              created_at::text, updated_at::text
         from crm_clients where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
}
