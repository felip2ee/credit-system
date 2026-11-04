"use client";

import { useState, useTransition } from "react";

import { loadMoreLedgerAction } from "@/actions/wallet-ledger";
import { ArrowDownLeft, ArrowUpRight, ReceiptText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { MONEY_TEXT_CLASS, MoneyTag } from "@/components/ui/money-tag";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatCurrency } from "@/lib/utils";
import { ledgerView } from "@/lib/wallet/ledger-view";
import type { LedgerEntry } from "@/lib/wallet/queries";

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const ICON = { in: ArrowDownLeft, out: ArrowUpRight, neutral: ReceiptText } as const;

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
    <section className="space-y-3">
      <SectionHeader title="Extrato" />
      {rows.length === 0 ? (
        <EmptyState icon={ReceiptText} title="Nenhum lançamento ainda." />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const v = ledgerView(row);
              const date = dateFormat.format(new Date(row.createdAt));
              return (
                <li key={row.id}>
                  <ListRow
                    icon={ICON[v.tone]}
                    iconClassName={MONEY_TEXT_CLASS[v.tone]}
                    title={v.title}
                    subtitle={v.detail ? `${date} · ${v.detail}` : date}
                    value={<MoneyTag tone={v.tone}>{[v.sign, formatCurrency(Math.abs(Number(row.amount)))].filter(Boolean).join(" ")}</MoneyTag>}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {error && <StatusBanner tone="attention" title={error} />}
      {cursor && (
        <Button variant="outline" onClick={loadMore} disabled={isPending}>
          {isPending ? "Carregando..." : "Carregar mais"}
        </Button>
      )}
    </section>
  );
}
