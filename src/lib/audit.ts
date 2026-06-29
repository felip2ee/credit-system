// Trilha de auditoria (LGPD / compliance).
// SOMENTE server-side. A tabela `audit_logs` não tem política de escrita RLS
// (só `admin` lê), então a gravação é feita via service-role — mesmo padrão de
// query_results_* / ai_reports.
//
// Best-effort: uma falha de auditoria NUNCA deve quebrar o fluxo principal.
// Toda a função é envolvida em try/catch e silenciosa em caso de erro.

import { headers } from "next/headers";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { Json } from "@/types/supabase";

export interface AuditParams {
  // Ex.: "bureau.consult" (acesso a dados de um documento no bureau).
  action: string;
  // Tabela/entidade relacionada (ex.: "queries").
  tableName?: string | null;
  // Id do registro relacionado (ex.: queryId).
  recordId?: string | null;
  // Dados estruturados do evento — vai para new_data (ex.: documento, tipo).
  data?: Record<string, unknown> | null;
}

// Extrai o IP do cliente dos headers de proxy. Retorna null se não for um IP
// válido (a coluna é `inet`; um valor inválido causaria erro de insert).
function clientIp(h: Headers): string | null {
  const xff = h.get("x-forwarded-for");
  const candidate = (xff?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim();
  if (!candidate) return null;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(candidate) || ipv6.test(candidate) ? candidate : null;
}

export async function recordAudit(params: AuditParams): Promise<void> {
  try {
    const {
      data: { user },
    } = await createClient().auth.getUser();

    const h = headers();
    const admin = createServiceClient();
    await admin.from("audit_logs").insert({
      user_id: user?.id ?? null,
      action: params.action,
      table_name: params.tableName ?? null,
      record_id: params.recordId ?? null,
      new_data: (params.data ?? null) as Json,
      ip_address: clientIp(h),
      user_agent: h.get("user-agent"),
    });
  } catch {
    // Auditoria é best-effort — não propaga erro para o fluxo principal.
  }
}
