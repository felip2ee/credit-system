import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listConsultations } from "@/lib/consultations/queries";
import { formatCNPJ, formatCPF } from "@/lib/utils";
import { QUERY_STATUS_LABEL, type QueryStatus } from "@/types/app";

const csvField = (v: string) => `"${v.replace(/"/g, '""')}"`;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  let session;
  try { session = await getRequiredSession(); } catch { return new Response("Sess\u00e3o expirada.", { status: 401 }); }
  if (!hasPermission(session.role, "consultations:read")) return new Response("N\u00e3o autorizado.", { status: 403 });
  const type = searchParams.get("type"); const status = searchParams.get("status");
  const rows = await listConsultations({ userId: session.userId, role: session.role }, { q: searchParams.get("q") ?? undefined, type: type === "PF" || type === "PJ" ? type : undefined, status: status && status in QUERY_STATUS_LABEL ? status as QueryStatus : undefined, from: searchParams.get("from") ?? undefined, to: searchParams.get("to") ?? undefined, limit: 5000 });
  const header = ["Data", "Tipo", "Documento", "Nome", "Produto", "Status"];
  const lines = rows.map((row) => [new Date(row.created_at).toLocaleString("pt-BR"), row.type, row.type === "PJ" ? formatCNPJ(row.document) : formatCPF(row.document), row.document_name ?? "", row.product ?? "", QUERY_STATUS_LABEL[row.status] ?? row.status].map((value) => csvField(String(value))).join(";"));
  return new Response("\ufeff" + [header.map(csvField).join(";"), ...lines].join("\r\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="consultas-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
