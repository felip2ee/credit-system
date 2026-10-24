// Tipos de domínio do Reino do Crédito.
// Refletem os enums e tabelas do esquema legado.

import type { NotificationStatus } from "@/lib/notifications/types";

export type UserRole = "superadmin" | "bureau_admin" | "operator" | "client";

export type EntityKind = "PF" | "PJ";

export type QueryStatus =
  | "pending_authorization"
  | "authorized"
  | "processing"
  | "completed"
  | "payload_incompatible"
  | "error"
  | "rejected";

export type DossierKind = "PF" | "PJ" | "PJ_FULL";

export type DossierStatus =
  | "pending"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "cancelled";

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

// ─── Titular / Sociedade ──────────────────────────────────────────────────

export type PartnershipSource = "deps" | "operator";

export type TimelineEntityType = "holder" | "query";

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

export interface HolderNote {
  id: string;
  content: string;
  created_by: string;
  created_at: string;
}

// ─── Consultas / SCR ───────────────────────────────────────────────────

export type ScrStatus = "pending" | "authorized" | "not_authorized" | "expired";

export interface QuerySummary {
  id: string;
  type: EntityKind;
  document: string;
  document_name: string | null;
  product: string | null;
  status: QueryStatus;
  holder_id: string;
  dossier_id: string;
  consulted_at: string | null;
  created_at: string;
}

export interface ScrAuthorization {
  id: string;
  document: string;
  type: EntityKind;
  name: string | null;
  email: string | null;
  consultation_id: string | null;
  holder_id: string;
  status: ScrStatus;
  requested_at: string;
  authorized_at: string | null;
  expires_at: string | null;
  last_checked_at: string | null;
  lastNotificationStatus: NotificationStatus | null;
}

export const QUERY_STATUS_LABEL: Record<QueryStatus, string> = {
  pending_authorization: "Aguardando SCR",
  authorized: "Autorizada",
  processing: "Processando",
  completed: "Concluída",
  payload_incompatible: "Dados incompatíveis",
  error: "Erro",
  rejected: "Recusada",
};

export const SCR_STATUS_LABEL: Record<ScrStatus, string> = {
  pending: "Pendente",
  authorized: "Concedida",
  not_authorized: "Não autorizada",
  expired: "Expirada",
};
