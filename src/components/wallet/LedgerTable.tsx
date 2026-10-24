"use client";

import { useState, useTransition } from "react";

import { loadMoreLedgerAction } from "@/actions/wallet-ledger";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LedgerEntry } from "@/lib/wallet/queries";
import { formatCurrency } from "@/lib/utils";

const KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  topup: "Recarga",
  reserve: "Reserva",
  capture: "Cobrança",
  release: "Liberação",
  adjustment: "Ajuste",
  reversal: "Estorno",
  client_adjustment_out: "Ajuste para cliente",
  client_adjustment_in: "Ajuste para cliente",
};

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

interface LedgerTableProps {
  bureauId: string;
  initialRows: LedgerEntry[];
  initialCursor: string | null;
}

export function LedgerTable({ bureauId, initialRows, initialCursor }: LedgerTableProps) {
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const res = await loadMoreLedgerAction({ bureauId, cursor });
      if (res.error || !res.page) {
        setError(res.error ?? "Não foi possível carregar o extrato.");
        return;
      }
      setRows((prev) => [...prev, ...res.page!.rows]);
      setCursor(res.page.nextCursor);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Extrato</CardTitle>
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
                <TableHead>Disponível após</TableHead>
                <TableHead>Reservado após</TableHead>
                <TableHead>Motivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{dateFormat.format(new Date(row.createdAt))}</TableCell>
                  <TableCell>{KIND_LABEL[row.kind]}</TableCell>
                  <TableCell>{formatCurrency(Number(row.amount))}</TableCell>
                  <TableCell>{formatCurrency(Number(row.availableAfter))}</TableCell>
                  <TableCell>{formatCurrency(Number(row.reservedAfter))}</TableCell>
                  <TableCell className="text-muted-foreground">{row.reason ?? "—"}</TableCell>
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
