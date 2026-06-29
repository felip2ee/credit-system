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
