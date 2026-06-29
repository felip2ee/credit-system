import Link from "next/link";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { ClientsFilters } from "@/components/clients/clients-filters";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";
import { formatCNPJ, formatCPF, formatDate, onlyDigits } from "@/lib/utils";
import type { CrmClient } from "@/types/app";

interface SearchParams {
  q?: string;
  type?: string;
  status?: string;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = createClient();

  let query = supabase
    .from("crm_clients")
    .select(
      "id, type, name, document, status, city, state, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(100);

  if (searchParams.type === "PF" || searchParams.type === "PJ") {
    query = query.eq("type", searchParams.type);
  }
  if (searchParams.status) {
    query = query.eq("status", searchParams.status);
  }
  if (searchParams.q) {
    const term = searchParams.q.trim();
    const docTerm = onlyDigits(term);
    const clauses = [`name.ilike.%${term}%`];
    if (docTerm.length > 0) clauses.push(`document.ilike.%${docTerm}%`);
    query = query.or(clauses.join(","));
  }

  const { data } = await query;
  const clients = (data ?? []) as Pick<
    CrmClient,
    "id" | "type" | "name" | "document" | "status" | "city" | "state" | "updated_at"
  >[];

  return (
    <div className="space-y-6">
      <PageHeader title="Clientes" description="CRM de relacionamento">
        <Button asChild>
          <Link href="/clients/new">
            <Plus className="h-4 w-4" />
            Novo cliente
          </Link>
        </Button>
      </PageHeader>

      <ClientsFilters />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Última atividade</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow key={c.id} className="cursor-pointer">
                  <TableCell className="font-medium">
                    <Link href={`/clients/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell>{c.type}</TableCell>
                  <TableCell>
                    {c.document
                      ? c.type === "PJ"
                        ? formatCNPJ(c.document)
                        : formatCPF(c.document)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {c.city ? `${c.city}${c.state ? "/" + c.state : ""}` : "—"}
                  </TableCell>
                  <TableCell>
                    <ClientStatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>{formatDate(c.updated_at)}</TableCell>
                </TableRow>
              ))}
              {clients.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    Nenhum cliente encontrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
