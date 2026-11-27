import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { StackedList, StackedRow } from "@/components/dashboard/stacked-list";
import { HoldersFilters } from "@/components/holders/holders-filters";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
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
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listHolders } from "@/lib/holders/queries";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

interface SearchParams {
  q?: string;
  type?: string;
}

export default async function HoldersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "holders:read")) redirect("/");
  const type =
    searchParams.type === "PF" || searchParams.type === "PJ" ? searchParams.type : undefined;
  const holders = await listHolders(session, { type, q: searchParams.q });
  const canWrite = hasPermission(session, "holders:write");

  return (
    <div className="space-y-6">
      <PageHeader title="Titulares" description="Pessoas físicas e jurídicas pesquisadas">
        {canWrite && (
          <Button asChild>
            <Link href="/holders/new">
              <Plus className="h-4 w-4" />
              Novo titular
            </Link>
          </Button>
        )}
      </PageHeader>

      <HoldersFilters />

      <Card>
        <CardContent className="p-0">
          <StackedList>
            {holders.map((h) => (
              <StackedRow
                key={h.id}
                href={`/holders/${h.id}`}
                title={h.name}
                meta={[
                  `${h.type === "PJ" ? "Pessoa jurídica" : "Pessoa física"} · ${h.type === "PJ" ? formatCNPJ(h.document) : formatCPF(h.document)}`,
                  h.city ? `${h.city}${h.state ? "/" + h.state : ""}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                aside={formatDate(h.updated_at)}
              />
            ))}
            {holders.length === 0 && (
              <li className="p-4 text-center text-sm text-muted-foreground">Nenhum titular encontrado.</li>
            )}
          </StackedList>
          <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Última atividade</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holders.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="font-medium">
                    <Link href={`/holders/${h.id}`} className="hover:underline">
                      {h.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{h.type}</Badge>
                  </TableCell>
                  <TableCell>
                    {h.type === "PJ" ? formatCNPJ(h.document) : formatCPF(h.document)}
                  </TableCell>
                  <TableCell>
                    {h.city ? `${h.city}${h.state ? "/" + h.state : ""}` : "—"}
                  </TableCell>
                  <TableCell>{formatDate(h.updated_at)}</TableCell>
                </TableRow>
              ))}
              {holders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Nenhum titular encontrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
