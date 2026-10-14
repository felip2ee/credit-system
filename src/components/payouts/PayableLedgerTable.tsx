"use client";

import { useState, useTransition } from "react";

import { loadMorePayablesAction } from "@/actions/payables-ledger";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PayableEntry } from "@/lib/payables/queries";
import { formatCurrency } from "@/lib/utils";

const KIND_LABEL: Record<PayableEntry["kind"], string> = {
  accrual: "Acréscimo",
  reversal: "Estorno",
  payout: "Repasse pago",
};

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

interface PayableLedgerTableProps {
  bureauId: string;
  initialRows: PayableEntry[];
  initialCursor: string | null;
}

export function PayableLedgerTable({ bureauId, initialRows, initialCursor }: PayableLedgerTableProps) {
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const res = await loadMorePayablesAction({ bureauId, cursor });
      if (res.error || !res.page) {
        setError(res.error ?? "Não foi possível carregar os lançamentos.");
        return;
      }
      setRows((prev) => [...prev, ...res.page!.rows]);
      setCursor(res.page.nextCursor);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Lançamentos</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum lançamento ainda.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{dateFormat.format(new Date(row.createdAt))}</TableCell>
                  <TableCell>{KIND_LABEL[row.kind]}</TableCell>
                  <TableCell>{formatCurrency(Number(row.amount))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {cursor && (
          <Button variant="outline" className="mt-4" onClick={loadMore} disabled={isPending}>
            {isPending ? "Carregando..." : "Carregar mais"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
