"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowDownLeft, ArrowUpRight, Receipt } from "lucide-react";
import type { ReactNode } from "react";

import { loadMoreClientLedgerAction } from "@/actions/credits-ledger";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";
import type { ClientPixCharge } from "@/lib/wallet/pix-charges";
import { buildStatement, clipChargesToLedgerWindow, type StatementLedgerEntry, type StatementTone } from "@/lib/wallet/statement";

const ICON = { in: ArrowDownLeft, out: ArrowUpRight, neutral: Receipt } as const;
const VALUE_CLASS: Record<StatementTone, string> = { in: "text-success", out: "", neutral: "text-muted-foreground" };

interface ClientStatementProps {
  initialLedger: StatementLedgerEntry[];
  initialCursor: string | null;
  charges: ClientPixCharge[];
  // Ação extra abaixo da linha, por id da linha (ex.: botão de recarga pendente).
  extras?: Record<string, ReactNode>;
}

export function ClientStatement({ initialLedger, initialCursor, charges, extras = {} }: ClientStatementProps) {
  const [ledger, setLedger] = useState(initialLedger);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const groups = buildStatement({ ledger, topups: clipChargesToLedgerWindow(charges, ledger, cursor !== null) });

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
      setLedger((prev) => [...prev, ...page.rows]);
      setCursor(page.nextCursor);
    });
  };

  return (
    <section id="extrato" className="scroll-mt-4 space-y-4">
      <SectionHeader title="Extrato" />
      {groups.length === 0 ? (
        <EmptyState icon={Receipt} title="Nenhum lançamento ainda" description="Suas recargas e pesquisas aparecem aqui." />
      ) : (
        groups.map((g) => (
          <div key={g.dateLabel} className="space-y-2">
            <h3 className="text-base font-bold text-muted-foreground">{g.dateLabel}</h3>
            <Card>
              <ul className="divide-y divide-border">
                {g.rows.map((r) => (
                  <li key={r.id}>
                    <ListRow
                      icon={ICON[r.tone]}
                      title={r.title}
                      subtitle={r.detail}
                      value={r.amount && <span className={cn(VALUE_CLASS[r.tone])}>{r.amount}</span>}
                    />
                    {(r.receiptHref || extras[r.id]) && (
                      <div className="flex flex-wrap items-center gap-x-4 pb-2 pl-4 pr-4 sm:pl-[4.5rem]">
                        {extras[r.id]}
                        {r.receiptHref && (
                          <Link href={r.receiptHref} className="inline-flex min-h-12 items-center font-bold text-primary underline">
                            Recibo
                          </Link>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        ))
      )}
      {error && <p role="alert" className="text-base font-bold text-destructive">{error}</p>}
      {cursor && (
        <Button type="button" variant="outline" size="lg" className="w-full sm:w-auto" onClick={loadMore} disabled={isPending}>
          {isPending ? "Carregando..." : "Carregar mais"}
        </Button>
      )}
    </section>
  );
}
