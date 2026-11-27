"use client";

import { useState, useTransition } from "react";

import { loadMorePayablesAction } from "@/actions/payables-ledger";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PayableEntry } from "@/lib/payables/queries";
import { formatCurrency } from "@/lib/utils";
import { StatusBanner } from "@/components/ui/status-banner";

const KIND_LABEL: Record<PayableEntry["kind"], string> = {
  accrual: "Lucro do pedido",
  reversal: "Pedido estornado",
  payout: "Repasse recebido",
  coupon_cost: "Cobertura de cupom",
  coupon_refund: "Devolução de cobertura de cupom",
};

// Acréscimo da entrada de dinheiro (072): a parte do Bureau num pagamento recebido, sem pedido.
const CASH_IN_ACCRUAL_LABEL = "Sua parte de um pagamento recebido";

const shortRef = (ref: string) => ref.slice(0, 8);

function formatSigned(amount: string): string {
  const n = Number(amount);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatCurrency(Math.abs(n))}`;
}

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

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
        <CardTitle className="text-lg">Lucros e repasses</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum lançamento ainda.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>O que foi</TableHead>
                <TableHead>Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{dateFormat.format(new Date(row.createdAt))}</TableCell>
                  <TableCell>
                    {row.kind === "accrual" && !row.orderRef && row.pixChargeId ? CASH_IN_ACCRUAL_LABEL : KIND_LABEL[row.kind]}
                    {row.orderRef && <span className="block text-xs text-muted-foreground">Pedido {shortRef(row.orderRef)}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-semibold tabular-nums">{formatSigned(row.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {error && (
          <StatusBanner tone="danger" title={error} />
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
