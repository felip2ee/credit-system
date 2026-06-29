import Link from "next/link";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { formatCNPJ, formatDate } from "@/lib/utils";

const BATCH_STATUS: Record<string, { label: string; variant: BadgeProps["variant"] }> = {
  pending: { label: "Pendente", variant: "secondary" },
  processing: { label: "Em andamento", variant: "secondary" },
  completed: { label: "Concluído", variant: "success" },
  completed_with_errors: { label: "Concluído com erros", variant: "destructive" },
  cancelled: { label: "Cancelado", variant: "muted" },
};

interface BatchRow {
  id: string;
  document: string | null;
  name: string | null;
  status: string;
  total_items: number;
  success_items: number;
  created_at: string;
}

export default async function BatchPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from("batches")
    .select("id, document, name, status, total_items, success_items, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const rows = (data ?? []) as BatchRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Processamento de empresa"
        description="Análise de uma empresa e seu quadro societário (CNPJ + sócios)"
      >
        <Button asChild>
          <Link href="/batch/new">
            <Plus className="h-4 w-4" />
            Novo processo
          </Link>
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Consultas</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Criado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => {
                const st = BATCH_STATUS[b.status] ?? BATCH_STATUS.pending;
                return (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">
                      <Link href={`/batch/${b.id}`} className="hover:underline">
                        {b.name ?? "Empresa sem nome"}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono">
                      {b.document ? formatCNPJ(b.document) : "—"}
                    </TableCell>
                    <TableCell>
                      {b.success_items}/{b.total_items} concluídas
                    </TableCell>
                    <TableCell>
                      <Badge variant={st.variant}>{st.label}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(b.created_at)}</TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Nenhum processo ainda.
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
