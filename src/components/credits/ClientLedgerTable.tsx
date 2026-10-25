"use client";

import { useState, useTransition } from "react";
import { ReceiptText } from "lucide-react";

import { loadMoreClientLedgerAction, type ClientLedgerRow } from "@/actions/credits-ledger";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
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
    <section className="space-y-3">
      <SectionHeader title="Extrato" />
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={ReceiptText} title="Nenhum lançamento ainda" description="Suas recargas e cobranças aparecem aqui." />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const { tone, label } = statusInfo("walletEntry", row.kind, "client");
              return (
                <li key={row.id} className="flex items-start gap-3 px-4 py-3">
                  <span aria-hidden className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-primary">
                    <ReceiptText className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <StatusBadge tone={tone} label={label} />
                    <p className="text-base text-muted-foreground">{dateFormat.format(new Date(row.createdAt))}</p>
                    <p className="text-base text-muted-foreground tabular-nums">
                      Disponível: {formatCurrency(Number(row.availableAfter))} · Reservado: {formatCurrency(Number(row.reservedAfter))}
                    </p>
                    {row.reason && <p className="break-words">{row.reason}</p>}
                  </div>
                  <span className="shrink-0 text-right text-lg font-bold tabular-nums">{clientLedgerAmount(row.kind, row.amount)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {error && <StatusBanner tone="attention" title={error} />}
      {cursor && (
        <Button variant="outline" className="w-full sm:w-auto" onClick={loadMore} disabled={isPending}>
          {isPending ? "Carregando..." : "Carregar mais"}
        </Button>
      )}
    </section>
  );
}
