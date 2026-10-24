"use client";

import { useState, useTransition } from "react";
import { ReceiptText } from "lucide-react";

import { loadMoreClientLedgerAction, type ClientLedgerRow } from "@/actions/credits-ledger";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusBanner } from "@/components/ui/status-banner";
import { clientLedgerAmount } from "@/components/credits/client-ledger-labels";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency } from "@/lib/utils";

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

interface ClientLedgerTableProps {
  initialRows: ClientLedgerRow[];
  initialCursor: string | null;
}

export function ClientLedgerTable({ initialRows, initialCursor }: ClientLedgerTableProps) {
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const res = await loadMoreClientLedgerAction({ cursor });
      if (res.error || !res.page) {
        setError(res.error ?? "Não foi possível carregar o extrato.");
        return;
      }
      const page = res.page;
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.nextCursor);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Extrato</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState icon={ReceiptText} title="Nenhum lançamento ainda" description="Suas recargas e cobranças aparecem aqui." />
        ) : (
          <ul className="divide-y">
            {rows.map((row) => {
              const { tone, label } = statusInfo("walletEntry", row.kind, "client");
              return (
                <li key={row.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StatusBadge tone={tone} label={label} />
                    <span className="text-lg font-bold">{clientLedgerAmount(row.kind, row.amount)}</span>
                  </div>
                  <p className="text-muted-foreground">{dateFormat.format(new Date(row.createdAt))}</p>
                  <p className="text-muted-foreground">
                    Disponível: {formatCurrency(Number(row.availableAfter))} · Reservado: {formatCurrency(Number(row.reservedAfter))}
                  </p>
                  {row.reason && <p>{row.reason}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {error && <StatusBanner tone="attention" title={error} className="mt-3" />}
        {cursor && (
          <Button variant="outline" className="mt-4 w-full sm:w-auto" onClick={loadMore} disabled={isPending}>
            {isPending ? "Carregando..." : "Carregar mais"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
