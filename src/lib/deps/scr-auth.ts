// Upsert do estado de autorização SCR por documento.
// Mantém UMA linha "corrente" por documento: atualiza a mais recente ou cria a
// primeira. Evita acumular duplicatas e deixar pendências obsoletas — a tela de
// SCR (aba Histórico) lista todas as linhas, então duplicatas poluiriam a visão.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/supabase";
import type { EntityKind, ScrStatus } from "@/types/app";

// Há autorização SCR vigente no nosso BD para este documento?
// Vale para os dois canais: linha `authorized` sem expiração ou ainda no prazo.
// Usada pelo modo de consulta "internal" (autogestão) para só disparar a deps
// quando o titular já autorizou no nosso sistema.
export async function hasValidInternalScr(
  supabase: SupabaseClient<Database>,
  document: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("scr_authorizations")
    .select("id")
    .eq("document", document)
    .eq("status", "authorized")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .limit(1)
    .maybeSingle();
  return !!data;
}

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

export async function upsertScrAuthorization(
  supabase: SupabaseClient<Database>,
  input: ScrAuthUpsert
): Promise<void> {
  const now = new Date().toISOString();
  const authorized = input.status === "authorized";

  const { data: existing } = await supabase
    .from("scr_authorizations")
    .select("id")
    .eq("document", input.document)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("scr_authorizations")
      .update({
        status: input.status,
        type: input.type,
        name: input.name ?? null,
        // email/crm_client_id só são sobrescritos quando informados (não apaga
        // valores já existentes no caminho de sucesso, que não traz e-mail).
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.crmClientId !== undefined
          ? { crm_client_id: input.crmClientId }
          : {}),
        query_id: input.queryId ?? null,
        last_checked_at: now,
        // Autorizado preserva requested_at e grava authorized_at; pendente
        // renova requested_at (reflete o reenvio do e-mail pela deps).
        ...(authorized ? { authorized_at: now } : { requested_at: now }),
      })
      .eq("id", (existing as { id: string }).id);
  } else {
    await supabase.from("scr_authorizations").insert({
      document: input.document,
      type: input.type,
      name: input.name ?? null,
      email: input.email ?? null,
      query_id: input.queryId ?? null,
      crm_client_id: input.crmClientId ?? null,
      status: input.status,
      requested_by: input.requestedBy ?? null,
      ...(authorized ? { authorized_at: now } : {}),
    });
  }
}
