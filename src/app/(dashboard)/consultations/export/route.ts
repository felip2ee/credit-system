import { createClient } from "@/lib/supabase/server";
import { formatCNPJ, formatCPF, onlyDigits } from "@/lib/utils";
import { QUERY_STATUS_LABEL, type QueryStatus } from "@/types/app";

interface QueryRow {
  type: "PF" | "PJ";
  document: string;
  document_name: string | null;
  product: string | null;
  status: QueryStatus;
  created_at: string;
}

const csvField = (v: string) => `"${v.replace(/"/g, '""')}"`;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const supabase = createClient();

  let query = supabase
    .from("queries")
    .select("type, document, document_name, product, status, created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  const type = searchParams.get("type");
  if (type === "PF" || type === "PJ") query = query.eq("type", type);

  const status = searchParams.get("status");
  if (status && status in QUERY_STATUS_LABEL) {
    query = query.eq("status", status as QueryStatus);
  }

  const from = searchParams.get("from");
  if (from) query = query.gte("created_at", from);
  const to = searchParams.get("to");
  if (to) query = query.lte("created_at", `${to}T23:59:59`);

  const q = searchParams.get("q");
  if (q) {
    const docTerm = onlyDigits(q);
    const clauses = [`document_name.ilike.%${q}%`];
    if (docTerm.length > 0) clauses.push(`document.ilike.%${docTerm}%`);
    query = query.or(clauses.join(","));
  }

  const { data } = await query;
  const rows = (data ?? []) as QueryRow[];

  const header = ["Data", "Tipo", "Documento", "Nome", "Produto", "Status"];
  const lines = rows.map((r) =>
    [
      new Date(r.created_at).toLocaleString("pt-BR"),
      r.type,
      r.type === "PJ" ? formatCNPJ(r.document) : formatCPF(r.document),
      r.document_name ?? "",
      r.product ?? "",
      QUERY_STATUS_LABEL[r.status] ?? r.status,
    ]
      .map((v) => csvField(String(v)))
      .join(";")
  );

  // BOM para o Excel reconhecer UTF-8.
  const csv = "﻿" + [header.map(csvField).join(";"), ...lines].join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="consultas-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
