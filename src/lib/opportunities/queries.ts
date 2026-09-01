import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { OpportunityDetailsInput } from "@/lib/validators/opportunity";
import { DEFAULT_FINANCING_SCENARIO, readScenario, realEstateSlots } from "@/lib/checklists/real-estate";
import { REAL_ESTATE_PRODUCT_NAME } from "@/lib/checklists/real-estate";
import { docSlotsFor, OPPORTUNITY_STATUS_LABEL, PRODUCT_DOC_SLOTS, type CrmClient, type CreditProduct, type DocSlot, type EntityKind, type Opportunity, type OpportunityDocStatus, type OpportunityDocument, type OpportunityStatus, type TimelineEvent } from "@/types/app";

type OppClient = Pick<CrmClient, "id" | "type" | "document" | "email" | "phone" | "address" | "address_number" | "address_complement" | "neighborhood" | "city" | "state" | "zip_code">;
type OppStatusRow = Pick<Opportunity, "id" | "status" | "crm_client_id">;

export type OpportunityMutation = { ok: true; id: string; crmClientId?: string; consultationId?: string | null } | { ok: false; reason: "consultation_not_found" | "consultation_not_completed" | "client_not_found" | "opportunity_not_found" };

const clientFields = "id, type, document, email, phone, address, address_number, address_complement, neighborhood, city, state, zip_code";

async function reconcileChecklist(client: PoolClient, opportunityId: string, template: DocSlot[]) {
  const { rows } = await client.query<{ id: string; doc_type: string; status: string; file_path: string | null }>(
    "select id, doc_type, status, file_path from opportunity_documents where opportunity_id = $1",
    [opportunityId],
  );
  const wanted = new Set(template.map(({ doc_type }) => doc_type));
  const add = template.filter((slot) => !rows.some((row) => row.doc_type === slot.doc_type));
  if (add.length) {
    await client.query(
      `insert into opportunity_documents (opportunity_id, doc_type, label, status)
       select $1, slot.doc_type, slot.label, 'pending'
       from jsonb_to_recordset($2::jsonb) as slot(doc_type text, label text)`,
      [opportunityId, JSON.stringify(add)],
    );
  }
  const remove = rows.filter((row) => !wanted.has(row.doc_type) && row.status === "pending" && !row.file_path).map((row) => row.id);
  if (remove.length) await client.query("delete from opportunity_documents where id = any($1::uuid[])", [remove]);
}

async function createOpportunityCore(client: PoolClient, identity: DbIdentity, person: OppClient, input: { consultationId: string | null; aiReportId: string | null; displayName: string }) {
  const inserted = await client.query<{ id: string }>(
    `insert into opportunities
       (crm_client_id, consultation_id, ai_report_id, credit_product_id, created_by, assigned_to, status,
        cnpj, responsible_cpf, responsible_email, responsible_phone, address, address_number,
        address_complement, neighborhood, city, state, zip_code)
     values ($1,$2,$3,null,$4,$4,'new',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning id`,
    [person.id, input.consultationId, input.aiReportId, identity.userId, person.type === "PJ" ? person.document : null, person.type === "PF" ? person.document : null, person.email, person.phone, person.address, person.address_number, person.address_complement, person.neighborhood, person.city, person.state, person.zip_code],
  );
  const id = inserted.rows[0].id;
  const slots = docSlotsFor(null, person.type);
  if (slots.length) {
    await client.query(
      `insert into opportunity_documents (opportunity_id, doc_type, label, status)
       select $1, slot.doc_type, slot.label, 'pending'
       from jsonb_to_recordset($2::jsonb) as slot(doc_type text, label text)`,
      [id, JSON.stringify(slots)],
    );
  }
  await client.query(
    `insert into timeline_events (entity_type, entity_id, event_type, title, description, metadata, created_by)
     values ('opportunity',$1,'opportunity.created','Oportunidade aberta',$2,null,$3),
            ('crm_client',$4,'opportunity.created','Oportunidade aberta',$2,jsonb_build_object('opportunity_id',$1),$3)`,
    [id, input.displayName, identity.userId, person.id],
  );
  await client.query("update crm_clients set status = 'in_intermediation' where id = $1 and status in ('prospect', 'active')", [person.id]);
  await writeAuditEvent(client, { actorId: identity.userId, action: "opportunity.create", targetTable: "opportunities", targetId: id, metadata: { consultationId: input.consultationId, crmClientId: person.id } });
  return id;
}

export async function createOpportunityFromConsultation(identity: DbIdentity, consultationId: string): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const consultation = await client.query<{ id: string; type: EntityKind; document: string; document_name: string | null; crm_client_id: string | null; status: string }>(
      "select id, type, document, document_name, crm_client_id, status::text from consultations where id = $1", [consultationId]);
    const query = consultation.rows[0];
    if (!query) return { ok: false, reason: "consultation_not_found" };
    if (query.status !== "completed") return { ok: false, reason: "consultation_not_completed" };
    const existing = await client.query<{ id: string }>("select id from opportunities where consultation_id = $1 limit 1", [consultationId]);
    if (existing.rows[0]) return { ok: true, id: existing.rows[0].id, consultationId };
    let crmClientId = query.crm_client_id;
    if (!crmClientId) {
      const found = await client.query<{ id: string }>("select id from crm_clients where document = $1 limit 1", [query.document.replace(/\D/g, "")]);
      crmClientId = found.rows[0]?.id ?? null;
      if (!crmClientId) {
        const made = await client.query<{ id: string }>(
          `insert into crm_clients (type, name, document, status, created_by, assigned_to)
           values ($1,$2,$3,'prospect',$4,$4) returning id`,
          [query.type, query.document_name ?? query.document, query.document.replace(/\D/g, ""), identity.userId],
        );
        crmClientId = made.rows[0].id;
        await client.query("insert into crm_client_documents (client_id, type, document, label, is_primary) values ($1,$2,$3,$4,true)", [crmClientId, query.type, query.document.replace(/\D/g, ""), query.type === "PJ" ? "CNPJ principal" : "CPF"]);
        await client.query("insert into timeline_events (entity_type, entity_id, event_type, title, description, created_by) values ('crm_client',$1,'client.created','Cliente cadastrado',$2,$3)", [crmClientId, query.document_name ?? query.document, identity.userId]);
      }
      await client.query("update consultations set crm_client_id = $2 where id = $1", [consultationId, crmClientId]);
    }
    const person = await client.query<OppClient>(`select ${clientFields} from crm_clients where id = $1`, [crmClientId]);
    if (!person.rows[0]) return { ok: false, reason: "client_not_found" };
    const report = await client.query<{ id: string }>("select id from ai_reports where consultation_id = $1", [consultationId]);
    const id = await createOpportunityCore(client, identity, person.rows[0], { consultationId, aiReportId: report.rows[0]?.id ?? null, displayName: query.document_name ?? query.document });
    return { ok: true, id, crmClientId: person.rows[0].id, consultationId };
  });
}

export async function createOpportunityForClient(identity: DbIdentity, clientId: string): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const person = await client.query<OppClient & { name: string }>(`select ${clientFields}, name from crm_clients where id = $1`, [clientId]);
    if (!person.rows[0]) return { ok: false, reason: "client_not_found" };
    const consultation = await client.query<{ id: string }>("select id from consultations where crm_client_id = $1 and status = 'completed' order by consulted_at desc nulls last limit 1", [clientId]);
    const consultationId = consultation.rows[0]?.id ?? null;
    const report = consultationId ? await client.query<{ id: string }>("select id from ai_reports where consultation_id = $1", [consultationId]) : { rows: [] as { id: string }[] };
    const id = await createOpportunityCore(client, identity, person.rows[0], { consultationId, aiReportId: report.rows[0]?.id ?? null, displayName: person.rows[0].name });
    return { ok: true, id, crmClientId: clientId, consultationId };
  });
}

export async function updateOpportunityDetailsRecord(identity: DbIdentity, id: string, data: OpportunityDetailsInput): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const changed = await client.query(
      `update opportunities set credit_product_id=$2, cnpj=$3, credit_purpose=$4, requested_amount=$5, monthly_revenue=$6,
       responsible_name=$7, responsible_email=$8, responsible_phone=$9, responsible_cpf=$10, responsible_birth_date=$11,
       responsible_mother_name=$12, address=$13, address_number=$14, address_complement=$15, neighborhood=$16,
       city=$17, state=$18, zip_code=$19, partner_name=$20, partner_notes=$21, notes=$22
       where id=$1 returning crm_client_id`,
      [id, data.credit_product_id, data.cnpj, data.credit_purpose, data.requested_amount, data.monthly_revenue, data.responsible_name, data.responsible_email, data.responsible_phone, data.responsible_cpf, data.responsible_birth_date, data.responsible_mother_name, data.address, data.address_number, data.address_complement, data.neighborhood, data.city, data.state, data.zip_code, data.partner_name, data.partner_notes, data.notes],
    );
    if (!changed.rows[0]) return { ok: false, reason: "opportunity_not_found" };
    if (data.credit_product_id) {
      const product = await client.query<{ name: string }>("select name from credit_products where id = $1", [data.credit_product_id]);
      const name = product.rows[0]?.name;
      if (name === REAL_ESTATE_PRODUCT_NAME) {
        const current = await client.query<{ pf_extra_data: Record<string, unknown> | null }>("select pf_extra_data from opportunities where id = $1", [id]);
        const extra = current.rows[0]?.pf_extra_data ?? null;
        const scenario = extra?.financing_scenario ? readScenario(extra) : DEFAULT_FINANCING_SCENARIO;
        if (!extra?.financing_scenario) await client.query("update opportunities set pf_extra_data = $2::jsonb where id = $1", [id, JSON.stringify({ ...(extra ?? {}), financing_scenario: scenario })]);
        await reconcileChecklist(client, id, realEstateSlots(scenario));
      } else if (name && PRODUCT_DOC_SLOTS[name]) await reconcileChecklist(client, id, PRODUCT_DOC_SLOTS[name]);
    }
    return { ok: true, id, crmClientId: changed.rows[0].crm_client_id };
  });
}

export async function updateFinancingScenarioRecord(identity: DbIdentity, id: string, scenario: Record<string, unknown>): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const current = await client.query<{ pf_extra_data: Record<string, unknown> | null; crm_client_id: string }>("select pf_extra_data, crm_client_id from opportunities where id = $1", [id]);
    if (!current.rows[0]) return { ok: false, reason: "opportunity_not_found" };
    const safe = readScenario({ financing_scenario: scenario });
    await client.query("update opportunities set pf_extra_data = $2::jsonb where id = $1", [id, JSON.stringify({ ...(current.rows[0].pf_extra_data ?? {}), financing_scenario: safe })]);
    await reconcileChecklist(client, id, realEstateSlots(safe));
    return { ok: true, id, crmClientId: current.rows[0].crm_client_id };
  });
}

export async function updateRealEstateOrderRecord(identity: DbIdentity, id: string, financingData: Record<string, string>): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const current = await client.query<{ pf_extra_data: Record<string, unknown> | null; crm_client_id: string }>("select pf_extra_data, crm_client_id from opportunities where id = $1", [id]);
    if (!current.rows[0]) return { ok: false, reason: "opportunity_not_found" };
    await client.query("update opportunities set pf_extra_data = $2::jsonb where id = $1", [id, JSON.stringify({ ...(current.rows[0].pf_extra_data ?? {}), financing_data: financingData })]);
    return { ok: true, id, crmClientId: current.rows[0].crm_client_id };
  });
}

async function writeStatusChange(client: PoolClient, identity: DbIdentity, opportunity: OppStatusRow, status: OpportunityStatus, extra?: { approvedAmount?: number | null; rejectionReason?: string | null }, auto = false) {
  await client.query(
    `update opportunities set status = $2,
       approved_amount = case when $2 = 'approved' and $3::numeric is not null then $3 else approved_amount end,
       rejection_reason = case when $2 = 'rejected' and $4::text is not null then $4 else rejection_reason end
     where id = $1`,
    [opportunity.id, status, extra?.approvedAmount ?? null, extra?.rejectionReason ?? null],
  );
  const description = auto ? "Atualização automática" : null;
  await client.query(
    `insert into timeline_events (entity_type, entity_id, event_type, title, description, metadata, created_by)
     values ('opportunity',$1,'opportunity.status_changed',$2,$3,$4::jsonb,$5),
            ('crm_client',$6,'opportunity.status_changed',$7,$3,$8::jsonb,$5)`,
    [opportunity.id, `Status: ${OPPORTUNITY_STATUS_LABEL[status]}`, description, JSON.stringify({ from: opportunity.status, to: status, auto }), identity.userId, opportunity.crm_client_id, `Oportunidade: ${OPPORTUNITY_STATUS_LABEL[status]}`, JSON.stringify({ opportunity_id: opportunity.id, from: opportunity.status, to: status, auto })],
  );
  if (status === "completed") await client.query("update crm_clients set status = 'completed' where id = $1", [opportunity.crm_client_id]);
}

async function autoAdvanceFromDocs(client: PoolClient, identity: DbIdentity, opportunityId: string) {
  const current = await client.query<OppStatusRow>("select id, status, crm_client_id from opportunities where id = $1", [opportunityId]);
  const opportunity = current.rows[0];
  if (!opportunity || (opportunity.status !== "new" && opportunity.status !== "documentation")) return;
  const documents = await client.query<{ status: OpportunityDocStatus }>("select status from opportunity_documents where opportunity_id = $1", [opportunityId]);
  if (!documents.rows.length) return;
  const allApproved = documents.rows.every(({ status }) => status === "approved");
  const anySent = documents.rows.some(({ status }) => status !== "pending");
  const target = allApproved ? "analysis" : anySent && opportunity.status === "new" ? "documentation" : null;
  if (target) await writeStatusChange(client, identity, opportunity, target, undefined, true);
}

export async function updateOpportunityStatusRecord(identity: DbIdentity, id: string, status: OpportunityStatus, extra?: { approvedAmount?: number | null; rejectionReason?: string | null }): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const current = await client.query<OppStatusRow>("select id, status, crm_client_id from opportunities where id = $1", [id]);
    if (!current.rows[0]) return { ok: false, reason: "opportunity_not_found" };
    await writeStatusChange(client, identity, current.rows[0], status, extra);
    return { ok: true, id, crmClientId: current.rows[0].crm_client_id };
  });
}

export async function addOpportunityNoteRecord(identity: DbIdentity, id: string, content: string): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const current = await client.query<{ crm_client_id: string }>("select crm_client_id from opportunities where id = $1", [id]);
    if (!current.rows[0]) return { ok: false, reason: "opportunity_not_found" };
    await client.query("insert into crm_notes (entity_type, entity_id, content, created_by) values ('opportunity',$1,$2,$3)", [id, content, identity.userId]);
    await client.query("insert into timeline_events (entity_type, entity_id, event_type, title, description, created_by) values ('opportunity',$1,'note.added','Anotação adicionada',$2,$3)", [id, content.slice(0, 140), identity.userId]);
    return { ok: true, id, crmClientId: current.rows[0].crm_client_id };
  });
}

async function recordDocumentEvent(client: PoolClient, identity: DbIdentity, opportunityId: string, label: string, fileName: string) {
  const current = await client.query<{ crm_client_id: string }>("select crm_client_id from opportunities where id = $1", [opportunityId]);
  if (!current.rows[0]) return null;
  await client.query(
    `insert into timeline_events (entity_type, entity_id, event_type, title, description, metadata, created_by)
     values ('opportunity',$1,'document.uploaded',$2,$3,null,$4),
            ('crm_client',$5,'document.uploaded',$2,$3,jsonb_build_object('opportunity_id',$1),$4)`,
    [opportunityId, `Documento enviado: ${label}`, fileName, identity.userId, current.rows[0].crm_client_id],
  );
  await autoAdvanceFromDocs(client, identity, opportunityId);
  return current.rows[0].crm_client_id;
}

export async function recordScannedDocumentUpload(identity: DbIdentity, opportunityId: string, label: string, fileName: string): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const crmClientId = await recordDocumentEvent(client, identity, opportunityId, label, fileName);
    return crmClientId ? { ok: true, id: opportunityId, crmClientId } : { ok: false, reason: "opportunity_not_found" };
  });
}

export async function setOpportunityDocumentStatusRecord(identity: DbIdentity, input: { docId: string; opportunityId: string; docLabel: string; status: Extract<OpportunityDocStatus, "approved" | "rejected">; rejectionReason?: string }): Promise<OpportunityMutation> {
  return withUserTransaction(identity, async (client) => {
    const result = await client.query("update opportunity_documents set status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now() where id=$1 and opportunity_id=$5", [input.docId, input.status, input.status === "rejected" ? input.rejectionReason ?? null : null, identity.userId, input.opportunityId]);
    if (result.rowCount !== 1) return { ok: false, reason: "opportunity_not_found" };
    const current = await client.query<{ crm_client_id: string }>("select crm_client_id from opportunities where id = $1", [input.opportunityId]);
    if (!current.rows[0]) return { ok: false, reason: "opportunity_not_found" };
    const eventType = input.status === "approved" ? "document.approved" : "document.rejected";
    const title = `${input.status === "approved" ? "Documento aprovado" : "Documento recusado"}: ${input.docLabel}`;
    await client.query(
      `insert into timeline_events (entity_type, entity_id, event_type, title, description, metadata, created_by)
       values ('opportunity',$1,$2,$3,$4,null,$5),
              ('crm_client',$6,$2,$3,$4,jsonb_build_object('opportunity_id',$1),$5)`,
      [input.opportunityId, eventType, title, input.rejectionReason ?? null, identity.userId, current.rows[0].crm_client_id],
    );
    await autoAdvanceFromDocs(client, identity, input.opportunityId);
    return { ok: true, id: input.docId, crmClientId: current.rows[0].crm_client_id };
  });
}

export interface OpportunityListItem { id: string; crm_client_id: string; status: OpportunityStatus; requested_amount: number | null; partner_name: string | null; updated_at: string; client_name: string; client_type: EntityKind; }
export async function listOpportunities(identity: DbIdentity, status?: OpportunityStatus | null): Promise<OpportunityListItem[]> {
  return withUserTransaction(identity, async (client) => {
    const result = await client.query<OpportunityListItem>(
      `select o.id, o.crm_client_id, o.status, o.requested_amount::float8 as requested_amount, o.partner_name,
              o.updated_at::text, c.name as client_name, c.type as client_type
         from opportunities o join crm_clients c on c.id = o.crm_client_id
        where ($1::text is null or o.status = $1)
        order by o.updated_at desc limit 100`, [status ?? null]);
    return result.rows;
  });
}

export interface OpportunityDetail { opportunity: Opportunity; client: Pick<CrmClient, "id" | "type" | "name" | "document"> | null; products: CreditProduct[]; documents: OpportunityDocument[]; events: TimelineEvent[]; }
export async function getOpportunityDetail(identity: DbIdentity, id: string): Promise<OpportunityDetail | null> {
  return withUserTransaction(identity, async (client) => {
    const opportunity = await client.query<Opportunity>(
      `select id, crm_client_id, consultation_id as query_id, ai_report_id, credit_product_id, assigned_to, created_by,
              status, credit_purpose, requested_amount::float8 as requested_amount, monthly_revenue::float8 as monthly_revenue,
              responsible_name, responsible_email, responsible_phone, responsible_cpf, responsible_birth_date::text,
              responsible_mother_name, address, address_number, address_complement, neighborhood, city, state, zip_code, cnpj,
              pf_extra_data, partner_name, partner_notes, approved_amount::float8 as approved_amount, rejection_reason,
              commission_rate::float8 as commission_rate, commission_amount::float8 as commission_amount, notes,
              created_at::text, updated_at::text from opportunities where id = $1`, [id]);
    const row = opportunity.rows[0];
    if (!row) return null;
    const [person, products, documents, events] = await Promise.all([
      client.query<Pick<CrmClient, "id" | "type" | "name" | "document">>("select id, type, name, document from crm_clients where id = $1", [row.crm_client_id]),
      client.query<CreditProduct>("select id, name, type, description, is_active from credit_products where is_active = true order by type, name"),
      client.query<OpportunityDocument>("select id, opportunity_id, doc_type, label, status, file_name, file_path, file_size, file_mime, uploaded_by, uploaded_at::text, rejection_reason, reviewed_by, reviewed_at::text, created_at::text, updated_at::text from opportunity_documents where opportunity_id = $1 order by created_at", [id]),
      client.query<TimelineEvent>("select id, entity_type, entity_id, event_type, title, description, metadata, created_by, created_at::text from timeline_events where entity_type = 'opportunity' and entity_id = $1 order by created_at desc", [id]),
    ]);
    return { opportunity: row, client: person.rows[0] ?? null, products: products.rows, documents: documents.rows, events: events.rows };
  });
}

export interface PortalOpportunityDetail { opportunity: Opportunity; documents: OpportunityDocument[]; events: TimelineEvent[]; }
export async function getPortalOpportunityDetail(identity: DbIdentity, id: string): Promise<PortalOpportunityDetail | null> {
  return withUserTransaction(identity, async (client) => {
    const opportunity = await client.query<Opportunity>(
      `select id, crm_client_id, consultation_id as query_id, ai_report_id, credit_product_id, assigned_to, created_by,
       status, credit_purpose, requested_amount::float8 as requested_amount, monthly_revenue::float8 as monthly_revenue,
       responsible_name, responsible_email, responsible_phone, responsible_cpf, responsible_birth_date::text, responsible_mother_name,
       address, address_number, address_complement, neighborhood, city, state, zip_code, cnpj, pf_extra_data, partner_name,
       partner_notes, approved_amount::float8 as approved_amount, rejection_reason, commission_rate::float8 as commission_rate,
       commission_amount::float8 as commission_amount, notes, created_at::text, updated_at::text from opportunities where id = $1`, [id]);
    const row = opportunity.rows[0];
    if (!row) return null;
    const [documents, events] = await Promise.all([
      client.query<OpportunityDocument>("select id, opportunity_id, doc_type, label, status, file_name, file_path, file_size, file_mime, uploaded_by, uploaded_at::text, rejection_reason, reviewed_by, reviewed_at::text, created_at::text, updated_at::text from opportunity_documents where opportunity_id = $1 and (status = 'pending' or scan_result = 'clean') order by created_at", [id]),
      client.query<TimelineEvent>("select id, entity_type, entity_id, event_type, title, description, metadata, created_by, created_at::text from timeline_events where entity_type = 'opportunity' and entity_id = $1 order by created_at desc", [id]),
    ]);
    return { opportunity: row, documents: documents.rows, events: events.rows };
  });
}
