"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { onlyDigits } from "@/lib/utils";
import {
  opportunityDetailsSchema,
  type OpportunityDetailsFormValues,
} from "@/lib/validators/opportunity";
import {
  docSlotsFor,
  OPPORTUNITY_STATUS_LABEL,
  PRODUCT_DOC_SLOTS,
  type DocSlot,
  type EntityKind,
  type OpportunityDocStatus,
  type OpportunityStatus,
} from "@/types/app";
import {
  DEFAULT_FINANCING_SCENARIO,
  REAL_ESTATE_PRODUCT_NAME,
  readScenario,
  realEstateSlots,
  type FinancingScenario,
} from "@/lib/checklists/real-estate";
import { REAL_ESTATE_ORDER_KEYS } from "@/lib/orders/real-estate-order";
import type { Database, Json } from "@/types/supabase";

// Alias curto para o client server-side (ver clients.ts / server.ts).
function db(): SupabaseClient<Database> {
  return createClient();
}

async function currentUserId(): Promise<string | null> {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  return user?.id ?? null;
}

export interface ActionResult {
  error: string | null;
  id?: string;
}

// ── Criação a partir de uma consulta concluída ────────────────────────────
// Pré-preenche o que dá com base no cadastro do cliente e na consulta, semeia
// o checklist de documentos e marca o cliente "em intermediação".
export async function createOpportunityFromQuery(
  queryId: string
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const { data: q } = await supabase
    .from("queries")
    .select("id, type, document, document_name, crm_client_id, status")
    .eq("id", queryId)
    .maybeSingle();
  if (!q) return { error: "Consulta não encontrada." };
  const query = q as {
    id: string;
    type: EntityKind;
    document: string;
    document_name: string | null;
    crm_client_id: string | null;
    status: string;
  };
  if (query.status !== "completed") {
    return { error: "A consulta precisa estar concluída." };
  }

  // Evita duplicar: se já existe oportunidade para esta consulta, reaproveita.
  const { data: existing } = await supabase
    .from("opportunities")
    .select("id")
    .eq("query_id", queryId)
    .maybeSingle();
  if (existing) {
    return { error: null, id: (existing as { id: string }).id };
  }

  // Resolve o cliente CRM. Consultas avulsas (ex.: processamento de empresa)
  // nascem sem crm_client_id — neste caso encontramos ou criamos o cliente a
  // partir do documento da consulta e vinculamos a consulta a ele.
  let crmClientId = query.crm_client_id;
  if (!crmClientId) {
    const doc = onlyDigits(query.document);
    const { data: foundClient } = await supabase
      .from("crm_clients")
      .select("id")
      .eq("document", doc)
      .maybeSingle();
    if (foundClient) {
      crmClientId = (foundClient as { id: string }).id;
    } else {
      const { data: createdClient, error: createErr } = await supabase
        .from("crm_clients")
        .insert({
          type: query.type,
          name: query.document_name ?? doc,
          document: doc,
          status: "prospect",
          created_by: userId,
          assigned_to: userId,
        })
        .select("id")
        .single();
      if (createErr || !createdClient) {
        return { error: createErr?.message ?? "Falha ao criar o cliente." };
      }
      crmClientId = (createdClient as { id: string }).id;
      await supabase.from("crm_client_documents").insert({
        client_id: crmClientId,
        type: query.type,
        document: doc,
        label: query.type === "PJ" ? "CNPJ principal" : "CPF",
        is_primary: true,
      });
      await supabase.from("timeline_events").insert({
        entity_type: "crm_client",
        entity_id: crmClientId,
        event_type: "client.created",
        title: "Cliente cadastrado",
        description: query.document_name ?? doc,
        created_by: userId,
      });
    }
    // Vincula a consulta ao cliente para reaproveitar nas próximas vezes.
    await supabase
      .from("queries")
      .update({ crm_client_id: crmClientId })
      .eq("id", queryId);
  }

  const { data: clientData } = await supabase
    .from("crm_clients")
    .select(
      "id, type, name, document, email, phone, address, address_number, address_complement, neighborhood, city, state, zip_code"
    )
    .eq("id", crmClientId)
    .maybeSingle();
  if (!clientData) return { error: "Cliente não encontrado." };
  const client = clientData as {
    id: string;
    type: EntityKind;
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
  };

  // Parecer de IA associado à consulta (para rastrear a origem).
  const { data: report } = await supabase
    .from("ai_reports")
    .select("id")
    .eq("query_id", queryId)
    .maybeSingle();
  const aiReportId = (report as { id: string } | null)?.id ?? null;

  return createOpportunityCore(supabase, userId, client, {
    queryId,
    aiReportId,
    displayName: query.document_name ?? query.document,
  });
}

interface OppClient {
  id: string;
  type: EntityKind;
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
}

const OPP_CLIENT_FIELDS =
  "id, type, document, email, phone, address, address_number, address_complement, neighborhood, city, state, zip_code";

// Núcleo de criação: insere a oportunidade (sem produto/instituição), semeia o
// checklist por tipo do cliente, registra a timeline (oportunidade + cliente) e
// move o cliente para "em intermediação". Compartilhado pelas duas entradas.
async function createOpportunityCore(
  supabase: SupabaseClient<Database>,
  userId: string,
  client: OppClient,
  opts: { queryId: string | null; aiReportId: string | null; displayName: string }
): Promise<ActionResult> {
  const { data: inserted, error: insErr } = await supabase
    .from("opportunities")
    .insert({
      crm_client_id: client.id,
      query_id: opts.queryId,
      ai_report_id: opts.aiReportId,
      credit_product_id: null,
      created_by: userId,
      assigned_to: userId,
      status: "new",
      cnpj: client.type === "PJ" ? client.document : null,
      responsible_cpf: client.type === "PF" ? client.document : null,
      responsible_email: client.email,
      responsible_phone: client.phone,
      address: client.address,
      address_number: client.address_number,
      address_complement: client.address_complement,
      neighborhood: client.neighborhood,
      city: client.city,
      state: client.state,
      zip_code: client.zip_code,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return { error: insErr?.message ?? "Falha ao criar a oportunidade." };
  }
  const opportunityId = (inserted as { id: string }).id;

  // Checklist inicial pelo tipo do cliente (sem produto ainda). Ao escolher o
  // produto, o checklist é reconciliado para o template dele (ver updateDetails).
  const slots = docSlotsFor(null, client.type).map((s) => ({
    opportunity_id: opportunityId,
    doc_type: s.doc_type,
    label: s.label,
    status: "pending" as const,
  }));
  if (slots.length > 0) {
    await supabase.from("opportunity_documents").insert(slots);
  }

  await supabase.from("timeline_events").insert([
    {
      entity_type: "opportunity",
      entity_id: opportunityId,
      event_type: "opportunity.created",
      title: "Oportunidade aberta",
      description: opts.displayName,
      created_by: userId,
    },
    {
      entity_type: "crm_client",
      entity_id: client.id,
      event_type: "opportunity.created",
      title: "Oportunidade aberta",
      description: opts.displayName,
      metadata: { opportunity_id: opportunityId },
      created_by: userId,
    },
  ]);

  await supabase
    .from("crm_clients")
    .update({ status: "in_intermediation" })
    .eq("id", client.id)
    .in("status", ["prospect", "active"]);

  await recordAudit({
    action: "opportunity.create",
    tableName: "opportunities",
    recordId: opportunityId,
    data: { query_id: opts.queryId, crm_client_id: client.id },
  });

  revalidatePath("/opportunities");
  revalidatePath(`/clients/${client.id}`);
  if (opts.queryId) revalidatePath(`/consultations/${opts.queryId}`);
  return { error: null, id: opportunityId };
}

// Abre uma oportunidade direto pela ficha do cliente. Vincula a consulta
// concluída mais recente (se houver) para herdar parecer e pré-preenchimento.
export async function createOpportunityForClient(
  clientId: string
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const { data: clientData } = await supabase
    .from("crm_clients")
    .select(`${OPP_CLIENT_FIELDS}, name`)
    .eq("id", clientId)
    .maybeSingle();
  if (!clientData) return { error: "Cliente não encontrado." };
  const client = clientData as OppClient & { name: string };

  const { data: q } = await supabase
    .from("queries")
    .select("id")
    .eq("crm_client_id", clientId)
    .eq("status", "completed")
    .order("consulted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const queryId = (q as { id: string } | null)?.id ?? null;

  let aiReportId: string | null = null;
  if (queryId) {
    const { data: report } = await supabase
      .from("ai_reports")
      .select("id")
      .eq("query_id", queryId)
      .maybeSingle();
    aiReportId = (report as { id: string } | null)?.id ?? null;
  }

  return createOpportunityCore(supabase, userId, client, {
    queryId,
    aiReportId,
    displayName: client.name,
  });
}

// Reconcilia o checklist com um template: adiciona os slots faltantes e remove
// os pendentes (sem arquivo) que não pertencem ao template. Nunca remove
// documentos já enviados/revisados.
async function reconcileChecklist(
  supabase: SupabaseClient<Database>,
  opportunityId: string,
  template: DocSlot[]
): Promise<void> {
  const { data } = await supabase
    .from("opportunity_documents")
    .select("id, doc_type, status, file_path")
    .eq("opportunity_id", opportunityId);
  const existing = (data ?? []) as {
    id: string;
    doc_type: string;
    status: string;
    file_path: string | null;
  }[];
  const templateTypes = new Set(template.map((t) => t.doc_type));

  const toAdd = template
    .filter((t) => !existing.some((e) => e.doc_type === t.doc_type))
    .map((t) => ({
      opportunity_id: opportunityId,
      doc_type: t.doc_type,
      label: t.label,
      status: "pending" as const,
    }));
  if (toAdd.length > 0) {
    await supabase.from("opportunity_documents").insert(toAdd);
  }

  const toRemove = existing
    .filter(
      (e) =>
        !templateTypes.has(e.doc_type) &&
        e.status === "pending" &&
        !e.file_path
    )
    .map((e) => e.id);
  if (toRemove.length > 0) {
    await supabase.from("opportunity_documents").delete().in("id", toRemove);
  }
}

// ── Atualização dos detalhes do crédito ───────────────────────────────────
export async function updateOpportunityDetails(
  id: string,
  values: OpportunityDetailsFormValues
): Promise<ActionResult> {
  const parsed = opportunityDetailsSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const data = parsed.data;
  const supabase = db();

  const { error } = await supabase
    .from("opportunities")
    .update({
      credit_product_id: data.credit_product_id,
      cnpj: data.cnpj,
      credit_purpose: data.credit_purpose,
      requested_amount: data.requested_amount,
      monthly_revenue: data.monthly_revenue,
      responsible_name: data.responsible_name,
      responsible_email: data.responsible_email,
      responsible_phone: data.responsible_phone,
      responsible_cpf: data.responsible_cpf,
      responsible_birth_date: data.responsible_birth_date,
      responsible_mother_name: data.responsible_mother_name,
      address: data.address,
      address_number: data.address_number,
      address_complement: data.address_complement,
      neighborhood: data.neighborhood,
      city: data.city,
      state: data.state,
      zip_code: data.zip_code,
      partner_name: data.partner_name,
      partner_notes: data.partner_notes,
      notes: data.notes,
    })
    .eq("id", id);
  if (error) return { error: error.message };

  // Ao definir um produto com template próprio, ajusta o checklist para ele.
  if (data.credit_product_id) {
    const { data: prod } = await supabase
      .from("credit_products")
      .select("name")
      .eq("id", data.credit_product_id)
      .maybeSingle();
    const name = (prod as { name: string } | null)?.name ?? null;
    if (name === REAL_ESTATE_PRODUCT_NAME) {
      // Checklist do imobiliário é gerado por cenário (default na 1ª vez).
      const { data: cur } = await supabase
        .from("opportunities")
        .select("pf_extra_data")
        .eq("id", id)
        .maybeSingle();
      const extra =
        ((cur as { pf_extra_data: Record<string, unknown> | null } | null)
          ?.pf_extra_data) ?? null;
      const scenario = extra?.["financing_scenario"]
        ? readScenario(extra)
        : DEFAULT_FINANCING_SCENARIO;
      if (!extra?.["financing_scenario"]) {
        await supabase
          .from("opportunities")
          .update({
            pf_extra_data: {
              ...(extra ?? {}),
              financing_scenario: scenario,
            } as unknown as Json,
          })
          .eq("id", id);
      }
      await reconcileChecklist(supabase, id, realEstateSlots(scenario));
    } else if (name && PRODUCT_DOC_SLOTS[name]) {
      await reconcileChecklist(supabase, id, PRODUCT_DOC_SLOTS[name]);
    }
  }

  revalidatePath(`/opportunities/${id}`);
  return { error: null, id };
}

// ── Cenário do Financiamento Imobiliário ──────────────────────────────────
// Define o cenário (perfil do comprador, imóvel, vendedor e cônjuge) e
// reconcilia o checklist para os documentos aplicáveis. Preserva os já enviados.
export async function updateFinancingScenario(
  opportunityId: string,
  scenario: FinancingScenario
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  // Normaliza/valida via o leitor (descarta valores fora do domínio).
  const safe = readScenario({ financing_scenario: scenario });

  const { data: cur } = await supabase
    .from("opportunities")
    .select("pf_extra_data")
    .eq("id", opportunityId)
    .maybeSingle();
  const extra =
    ((cur as { pf_extra_data: Record<string, unknown> | null } | null)
      ?.pf_extra_data) ?? null;

  const { error } = await supabase
    .from("opportunities")
    .update({
      pf_extra_data: {
        ...(extra ?? {}),
        financing_scenario: safe,
      } as unknown as Json,
    })
    .eq("id", opportunityId);
  if (error) return { error: error.message };

  await reconcileChecklist(supabase, opportunityId, realEstateSlots(safe));

  revalidatePath(`/opportunities/${opportunityId}`);
  return { error: null, id: opportunityId };
}

// ── Dados do pedido de Financiamento Imobiliário (PF) ─────────────────────
// Persiste os dados iniciais do pedido (proponente + imóvel) em
// pf_extra_data.financing_data, sem mexer no cenário/checklist.
export async function updateRealEstateOrder(
  opportunityId: string,
  data: Record<string, string>
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const clean = REAL_ESTATE_ORDER_KEYS.reduce(
    (acc, k) => {
      acc[k] = (data[k] ?? "").trim();
      return acc;
    },
    {} as Record<string, string>
  );

  const { data: cur } = await supabase
    .from("opportunities")
    .select("pf_extra_data")
    .eq("id", opportunityId)
    .maybeSingle();
  const extra =
    ((cur as { pf_extra_data: Record<string, unknown> | null } | null)
      ?.pf_extra_data) ?? null;

  const { error } = await supabase
    .from("opportunities")
    .update({
      pf_extra_data: {
        ...(extra ?? {}),
        financing_data: clean,
      } as unknown as Json,
    })
    .eq("id", opportunityId);
  if (error) return { error: error.message };

  revalidatePath(`/opportunities/${opportunityId}`);
  return { error: null, id: opportunityId };
}

// ── Mudança de status no pipeline ─────────────────────────────────────────
export interface StatusExtra {
  approvedAmount?: number | null;
  rejectionReason?: string | null;
}

interface OppStatusRow {
  id: string;
  status: OpportunityStatus;
  crm_client_id: string;
}

// Núcleo da troca de status: aplica o patch, registra a timeline (oportunidade
// + cliente) e conclui o cliente quando a oportunidade é concluída. Não
// revalida — quem chama cuida disso. `auto` marca avanços automáticos.
async function writeStatusChange(
  supabase: SupabaseClient<Database>,
  opp: OppStatusRow,
  status: OpportunityStatus,
  userId: string | null,
  opts?: { extra?: StatusExtra; auto?: boolean }
): Promise<{ error: string | null }> {
  const patch: Database["public"]["Tables"]["opportunities"]["Update"] = {
    status,
  };
  if (status === "approved" && opts?.extra?.approvedAmount != null) {
    patch.approved_amount = opts.extra.approvedAmount;
  }
  if (status === "rejected" && opts?.extra?.rejectionReason) {
    patch.rejection_reason = opts.extra.rejectionReason;
  }

  const { error } = await supabase
    .from("opportunities")
    .update(patch)
    .eq("id", opp.id);
  if (error) return { error: error.message };

  const auto = opts?.auto ?? false;
  const note = auto ? "Atualização automática" : null;
  await supabase.from("timeline_events").insert([
    {
      entity_type: "opportunity",
      entity_id: opp.id,
      event_type: "opportunity.status_changed",
      title: `Status: ${OPPORTUNITY_STATUS_LABEL[status]}`,
      description: note,
      metadata: { from: opp.status, to: status, auto },
      created_by: userId,
    },
    {
      entity_type: "crm_client",
      entity_id: opp.crm_client_id,
      event_type: "opportunity.status_changed",
      title: `Oportunidade: ${OPPORTUNITY_STATUS_LABEL[status]}`,
      description: note,
      metadata: { opportunity_id: opp.id, from: opp.status, to: status, auto },
      created_by: userId,
    },
  ]);

  // Conclui o cliente quando a oportunidade é concluída.
  if (status === "completed") {
    await supabase
      .from("crm_clients")
      .update({ status: "completed" })
      .eq("id", opp.crm_client_id);
  }
  return { error: null };
}

export async function updateOpportunityStatus(
  id: string,
  status: OpportunityStatus,
  extra?: StatusExtra
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();

  const { data: current } = await supabase
    .from("opportunities")
    .select("id, status, crm_client_id")
    .eq("id", id)
    .maybeSingle();
  if (!current) return { error: "Oportunidade não encontrada." };
  const opp = current as OppStatusRow;

  const { error } = await writeStatusChange(supabase, opp, status, userId, {
    extra,
  });
  if (error) return { error };

  revalidatePath(`/opportunities/${id}`);
  revalidatePath("/opportunities");
  revalidatePath(`/clients/${opp.crm_client_id}`);
  return { error: null, id };
}

// Avança o status automaticamente conforme o checklist evolui:
// 1º documento enviado → DOCUMENTAÇÃO; todos aprovados → ANÁLISE.
// Só avança a partir das fases iniciais (new/documentation) e nunca retrocede,
// para não atropelar mudanças manuais feitas pelo operador.
async function autoAdvanceFromDocs(
  supabase: SupabaseClient<Database>,
  opportunityId: string,
  userId: string | null
): Promise<void> {
  const { data: oppData } = await supabase
    .from("opportunities")
    .select("id, status, crm_client_id")
    .eq("id", opportunityId)
    .maybeSingle();
  if (!oppData) return;
  const opp = oppData as OppStatusRow;
  if (opp.status !== "new" && opp.status !== "documentation") return;

  const { data: docsData } = await supabase
    .from("opportunity_documents")
    .select("status")
    .eq("opportunity_id", opportunityId);
  const docs = (docsData ?? []) as { status: OpportunityDocStatus }[];
  if (docs.length === 0) return;

  const allApproved = docs.every((d) => d.status === "approved");
  const anySent = docs.some((d) => d.status !== "pending");

  let target: OpportunityStatus | null = null;
  if (allApproved) target = "analysis";
  else if (anySent && opp.status === "new") target = "documentation";
  if (!target || target === opp.status) return;

  await writeStatusChange(supabase, opp, target, userId, { auto: true });
  revalidatePath("/opportunities");
}

// ── Anotação ──────────────────────────────────────────────────────────────
export async function addOpportunityNote(
  id: string,
  content: string
): Promise<ActionResult> {
  const text = content.trim();
  if (text.length < 1) return { error: "Anotação vazia." };

  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const { error } = await supabase.from("crm_notes").insert({
    entity_type: "opportunity",
    entity_id: id,
    content: text,
    created_by: userId,
  });
  if (error) return { error: error.message };

  await supabase.from("timeline_events").insert({
    entity_type: "opportunity",
    entity_id: id,
    event_type: "note.added",
    title: "Anotação adicionada",
    description: text.slice(0, 140),
    created_by: userId,
  });

  revalidatePath(`/opportunities/${id}`);
  return { error: null, id };
}

// ── Documentos ─────────────────────────────────────────────────────────────

// crm_client_id da oportunidade — para espelhar eventos na timeline do cliente.
async function clientIdOfOpportunity(
  supabase: SupabaseClient<Database>,
  opportunityId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("opportunities")
    .select("crm_client_id")
    .eq("id", opportunityId)
    .maybeSingle();
  return (data as { crm_client_id: string } | null)?.crm_client_id ?? null;
}

// Registra os metadados após o upload do arquivo no Storage (feito no client
// com o browser client). O binário NÃO passa pelo Server Action.
export interface RecordUploadInput {
  docId: string;
  opportunityId: string;
  docLabel: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileMime: string;
}

export async function recordOpportunityDocUpload(
  input: RecordUploadInput
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const { error } = await supabase
    .from("opportunity_documents")
    .update({
      status: "uploaded",
      file_name: input.fileName,
      file_path: input.filePath,
      file_size: input.fileSize,
      file_mime: input.fileMime,
      uploaded_by: userId,
      uploaded_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq("id", input.docId);
  if (error) return { error: error.message };

  const crmClientId = await clientIdOfOpportunity(supabase, input.opportunityId);
  await supabase.from("timeline_events").insert([
    {
      entity_type: "opportunity" as const,
      entity_id: input.opportunityId,
      event_type: "document.uploaded",
      title: `Documento enviado: ${input.docLabel}`,
      description: input.fileName,
      created_by: userId,
    },
    ...(crmClientId
      ? [
          {
            entity_type: "crm_client" as const,
            entity_id: crmClientId,
            event_type: "document.uploaded",
            title: `Documento enviado: ${input.docLabel}`,
            description: input.fileName,
            metadata: { opportunity_id: input.opportunityId },
            created_by: userId,
          },
        ]
      : []),
  ]);

  await autoAdvanceFromDocs(supabase, input.opportunityId, userId);

  revalidatePath(`/opportunities/${input.opportunityId}`);
  if (crmClientId) revalidatePath(`/clients/${crmClientId}`);
  return { error: null, id: input.docId };
}

export async function setOpportunityDocStatus(
  docId: string,
  opportunityId: string,
  docLabel: string,
  status: Extract<OpportunityDocStatus, "approved" | "rejected">,
  rejectionReason?: string
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();

  const { error } = await supabase
    .from("opportunity_documents")
    .update({
      status,
      rejection_reason: status === "rejected" ? rejectionReason ?? null : null,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", docId);
  if (error) return { error: error.message };

  const eventType =
    status === "approved" ? "document.approved" : "document.rejected";
  const title =
    status === "approved"
      ? `Documento aprovado: ${docLabel}`
      : `Documento recusado: ${docLabel}`;

  const crmClientId = await clientIdOfOpportunity(supabase, opportunityId);
  await supabase.from("timeline_events").insert([
    {
      entity_type: "opportunity" as const,
      entity_id: opportunityId,
      event_type: eventType,
      title,
      description: rejectionReason ?? null,
      created_by: userId,
    },
    ...(crmClientId
      ? [
          {
            entity_type: "crm_client" as const,
            entity_id: crmClientId,
            event_type: eventType,
            title,
            description: rejectionReason ?? null,
            metadata: { opportunity_id: opportunityId },
            created_by: userId,
          },
        ]
      : []),
  ]);

  await autoAdvanceFromDocs(supabase, opportunityId, userId);

  revalidatePath(`/opportunities/${opportunityId}`);
  if (crmClientId) revalidatePath(`/clients/${crmClientId}`);
  return { error: null, id: docId };
}

// Gera uma URL assinada (temporária) para baixar o arquivo do bucket privado.
export interface SignedUrlResult {
  error: string | null;
  url?: string;
}

export async function getOpportunityDocUrl(
  filePath: string
): Promise<SignedUrlResult> {
  const admin = createServiceClient();
  const { data, error } = await admin.storage
    .from("opportunity-docs")
    .createSignedUrl(filePath, 60 * 10);
  if (error || !data) {
    return { error: error?.message ?? "Falha ao gerar o link." };
  }
  return { error: null, url: data.signedUrl };
}
