"use client";

import { useState, useTransition } from "react";

import { loadMoreLedgerAction } from "@/actions/wallet-ledger";
import { ReceiptText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { statusInfo } from "@/lib/ui/status";
import type { LedgerEntry } from "@/lib/wallet/queries";
import { formatCurrency } from "@/lib/utils";

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
          <EmptyState icon={ReceiptText} title="Nenhum lançamento ainda." />
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
                  <TableCell>{statusInfo("walletEntry", row.kind, "staff").label}</TableCell>
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
          <StatusBanner tone="attention" className="mt-3" title={error} />
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
