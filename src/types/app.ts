// Tipos de domínio do Reino do Crédito.
// Refletem os enums e tabelas de supabase/migrations/001_initial_schema.sql.

export type UserRole = "admin" | "consultant" | "client";

export type EntityKind = "PF" | "PJ";

export type QueryStatus =
  | "pending_authorization"
  | "authorized"
  | "processing"
  | "completed"
  | "error"
  | "rejected";

export type BatchStatus =
  | "pending"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "cancelled";

export type CrmClientStatus =
  | "prospect"
  | "active"
  | "in_intermediation"
  | "completed"
  | "inactive";

export type AptitudeStatus = "pending" | "apt" | "apt_with_caveats" | "inapt";

export type DocumentStatus = "pending" | "uploaded" | "approved" | "rejected";

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  avatar_url: string | null;
  is_active: boolean;
  mfa_enabled: boolean;
}

// ─── CRM ─────────────────────────────────────────────────────────────────

export interface CrmClient {
  id: string;
  type: EntityKind;
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
  assigned_to: string | null;
  user_id: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type CrmRelationType =
  | "socio"
  | "conjuge"
  | "avalista"
  | "grupo_economico"
  | "responsavel";

export interface CrmClientRelation {
  id: string;
  client_id: string;
  related_id: string;
  relation_type: CrmRelationType;
  percentage: number | null;
  role: string | null;
  created_at: string;
}

export type TimelineEntityType = "crm_client" | "opportunity" | "query";

export interface TimelineEvent {
  id: string;
  entity_type: TimelineEntityType;
  entity_id: string;
  event_type: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
}

export interface CrmNote {
  id: string;
  entity_type: TimelineEntityType;
  entity_id: string;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const CRM_STATUS_LABEL: Record<CrmClientStatus, string> = {
  prospect: "Prospecto",
  active: "Ativo",
  in_intermediation: "Em intermediação",
  completed: "Concluído",
  inactive: "Inativo",
};

// ─── Consultas / SCR ───────────────────────────────────────────────────

export type ScrStatus = "pending" | "authorized" | "not_authorized" | "expired";

export interface QuerySummary {
  id: string;
  type: EntityKind;
  document: string;
  document_name: string | null;
  product: string | null;
  status: QueryStatus;
  crm_client_id: string | null;
  consulted_at: string | null;
  created_at: string;
}

export interface ScrAuthorization {
  id: string;
  document: string;
  type: EntityKind;
  name: string | null;
  email: string | null;
  query_id: string | null;
  crm_client_id: string | null;
  status: ScrStatus;
  requested_at: string;
  authorized_at: string | null;
  expires_at: string | null;
  last_checked_at: string | null;
}

export const QUERY_STATUS_LABEL: Record<QueryStatus, string> = {
  pending_authorization: "Aguardando SCR",
  authorized: "Autorizada",
  processing: "Processando",
  completed: "Concluída",
  error: "Erro",
  rejected: "Recusada",
};

export const SCR_STATUS_LABEL: Record<ScrStatus, string> = {
  pending: "Pendente",
  authorized: "Concedida",
  not_authorized: "Não autorizada",
  expired: "Expirada",
};

// ─── Oportunidades (Fase 4) ──────────────────────────────────────────────

export type OpportunityStatus =
  | "new"
  | "documentation"
  | "analysis"
  | "sent_to_partner"
  | "approved"
  | "rejected"
  | "completed"
  | "cancelled";

export interface CreditProduct {
  id: string;
  name: string;
  type: EntityKind;
  description: string | null;
  is_active: boolean;
}

export interface Opportunity {
  id: string;
  crm_client_id: string;
  query_id: string | null;
  ai_report_id: string | null;
  credit_product_id: string | null;
  assigned_to: string | null;
  created_by: string;
  status: OpportunityStatus;
  credit_purpose: string | null;
  requested_amount: number | null;
  monthly_revenue: number | null;
  responsible_name: string | null;
  responsible_email: string | null;
  responsible_phone: string | null;
  responsible_cpf: string | null;
  responsible_birth_date: string | null;
  responsible_mother_name: string | null;
  address: string | null;
  address_number: string | null;
  address_complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  cnpj: string | null;
  pf_extra_data: Record<string, unknown> | null;
  partner_name: string | null;
  partner_notes: string | null;
  approved_amount: number | null;
  rejection_reason: string | null;
  commission_rate: number | null;
  commission_amount: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type OpportunityDocStatus = "pending" | "uploaded" | "approved" | "rejected";

export interface OpportunityDocument {
  id: string;
  opportunity_id: string;
  doc_type: string;
  label: string;
  status: OpportunityDocStatus;
  file_name: string | null;
  file_path: string | null;
  file_size: number | null;
  file_mime: string | null;
  uploaded_by: string | null;
  uploaded_at: string | null;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const OPPORTUNITY_STATUS_LABEL: Record<OpportunityStatus, string> = {
  new: "Nova",
  documentation: "Documentação",
  analysis: "Análise",
  sent_to_partner: "Enviada ao parceiro",
  approved: "Aprovada",
  rejected: "Recusada",
  completed: "Concluída",
  cancelled: "Cancelada",
};

// Ordem do pipeline (etapas lineares). approved/rejected/completed/cancelled
// são estados terminais; os 4 primeiros formam o avanço normal.
export const OPPORTUNITY_PIPELINE: OpportunityStatus[] = [
  "new",
  "documentation",
  "analysis",
  "sent_to_partner",
];

export const OPPORTUNITY_DOC_STATUS_LABEL: Record<OpportunityDocStatus, string> = {
  pending: "Pendente",
  uploaded: "Enviado",
  approved: "Aprovado",
  rejected: "Recusado",
};

export interface DocSlot {
  doc_type: string;
  label: string;
}

// Checklist padrão de análise bancária PJ (lista oficial Reino do Crédito:
// "Lista de documentos para análise bancária"). Seções DOCUMENTOS NECESSÁRIOS
// (empresa) + DOCUMENTOS DOS SÓCIOS. As INFORMAÇÕES NECESSÁRIAS da lista são
// campos do formulário da oportunidade, não slots de upload.
const PJ_BANK_ANALYSIS_DOCS: DocSlot[] = [
  // Empresa
  { doc_type: "personal_id", label: "Documento pessoal (RG ou CNH)" },
  {
    doc_type: "revenue_proof_12m",
    label: "Comprovante de faturamento dos últimos 12 meses",
  },
  { doc_type: "address_proof", label: "Comprovante de endereço" },
  { doc_type: "cnpj_card", label: "Cartão CNPJ" },
  { doc_type: "social_contract", label: "Contrato social" },
  {
    doc_type: "contract_amendments",
    label: "Todas as alterações contratuais da empresa",
  },
  {
    doc_type: "consolidated_contract",
    label: "Contrato social consolidado (se houver)",
  },
  { doc_type: "pgdas_defis", label: "Declaração PGDAS e DEFIS" },
  { doc_type: "irpf", label: "Declaração de Imposto de Renda PF" },
  { doc_type: "marriage_birth_cert", label: "Certidão de casamento/nascimento" },
  // Sócios (se houver)
  { doc_type: "partner_id", label: "Sócios — Identidade/CNH" },
  { doc_type: "partner_address_proof", label: "Sócios — Comprovante de endereço" },
  { doc_type: "partner_irpf", label: "Sócios — Imposto de Renda PF" },
  {
    doc_type: "partner_marriage_birth_cert",
    label: "Sócios — Certidão de casamento/nascimento",
  },
];

const PF_DEFAULT_DOCS: DocSlot[] = [
  { doc_type: "personal_id", label: "Documento pessoal (RG/CNH)" },
  { doc_type: "address_proof", label: "Comprovante de endereço" },
  { doc_type: "irpf", label: "Declaração de Imposto de Renda PF" },
  { doc_type: "income_proof", label: "Comprovante de renda" },
  { doc_type: "marriage_birth_cert", label: "Certidão de casamento/nascimento" },
];

// Fallback por tipo de cliente (quando o produto não tem template específico).
export const DEFAULT_DOC_SLOTS: Record<EntityKind, DocSlot[]> = {
  PJ: PJ_BANK_ANALYSIS_DOCS,
  PF: PF_DEFAULT_DOCS,
};

// Template de documentos POR PRODUTO de crédito (chave = nome em credit_products,
// conforme seed da migration 001). Quando o produto selecionado tem template
// aqui, ele substitui o fallback por tipo. Adicione os demais produtos conforme
// o padrão de cada banco/linha.
export const PRODUCT_DOC_SLOTS: Record<string, DocSlot[]> = {
  "Capital de Giro": PJ_BANK_ANALYSIS_DOCS,
};

// Resolve o checklist a usar: template do produto (se houver) ou padrão do tipo.
export function docSlotsFor(
  productName: string | null,
  type: EntityKind
): DocSlot[] {
  if (productName && PRODUCT_DOC_SLOTS[productName]) {
    return PRODUCT_DOC_SLOTS[productName];
  }
  return DEFAULT_DOC_SLOTS[type];
}
