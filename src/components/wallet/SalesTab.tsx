import { ReceiptText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { FilterChips, type Chip } from "@/components/wallet/FilterChips";
import { MoreLinks } from "@/components/wallet/MoreLinks";
import { TabIntro } from "@/components/wallet/TabIntro";
import { statusInfo } from "@/lib/ui/status";
import { formatDateSP } from "@/lib/utils";
import { formatMoney } from "@/lib/wallet/money";
import type { SaleMode, SalesPage } from "@/lib/wallet/sales";

const INTRO: Record<SaleMode, string> = {
  online: "Pedidos que seus clientes pagaram com o saldo do app. Você vê o que o cliente pagou, o custo e a sua parte.",
  counter: "Pedidos que você cobrou no balcão. Você vê o que o cliente pagou, o custo e a sua parte.",
};

function Money({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`text-base tabular-nums ${strong ? "font-bold" : ""}`}>{formatMoney(value)}</dd>
    </div>
  );
}

export function SalesTab({
  mode,
  page,
  periodChips,
  period,
  nextHref,
  startHref,
}: {
  mode: SaleMode;
  page: SalesPage;
  periodChips: readonly Chip[];
  period: string;
  nextHref: string | null;
  startHref: string | null;
}) {
  const { rows, totals } = page;
  return (
    <div className="space-y-4">
      <TabIntro>{INTRO[mode]}</TabIntro>
      <FilterChips label="Período" chips={periodChips} active={period} />
      <Card className="p-4">
        <h2 className="text-base text-muted-foreground">Total do período</h2>
        <dl className="mt-2 grid grid-cols-3 gap-3">
          <Money label="Cliente pagou" value={totals.paid} />
          <Money label="Custo" value={totals.cost} />
          <Money label="Sua parte" value={totals.bureauShare} strong />
        </dl>
        <p className="mt-2 text-sm text-muted-foreground">Pedidos cancelados ou devolvidos não entram na soma.</p>
      </Card>
      {rows.length === 0 ? (
        <EmptyState icon={ReceiptText} title="Nenhum pedido neste período" description="Escolha outro período para ver mais pedidos." />
      ) : (
        <Card>
          <ul className="divide-y">
            {rows.map((r) => {
              const pay = statusInfo("payment", r.status, "staff");
              return (
                <li key={r.orderRef} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-bold">{r.holderName}</p>
                      <p className="text-sm text-muted-foreground">
                        {r.productName} · {formatDateSP(r.createdAt)}
                      </p>
                    </div>
                    <StatusBadge tone={pay.tone} label={pay.label} />
                  </div>
                  <dl className="grid grid-cols-3 gap-3">
                    <Money label="Cliente pagou" value={r.paid} />
                    <Money label="Custo" value={r.cost} />
                    <Money label="Sua parte" value={r.bureauShare} strong />
                  </dl>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <MoreLinks nextHref={nextHref} startHref={startHref} />
    </div>
  );
}
