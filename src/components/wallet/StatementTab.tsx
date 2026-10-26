import { ArrowDownLeft, ArrowUpRight, ReceiptText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { FilterChips, type Chip } from "@/components/wallet/FilterChips";
import { MoreLinks } from "@/components/wallet/MoreLinks";
import { TabIntro } from "@/components/wallet/TabIntro";
import { cn } from "@/lib/utils";
import { formatSignedMoney } from "@/lib/wallet/money";
import type { StatementPage, StatementTone } from "@/lib/wallet/statement-total";

const ICON = { in: ArrowDownLeft, out: ArrowUpRight, neutral: ReceiptText } as const;
const VALUE_CLASS: Record<StatementTone, string> = { in: "text-success", out: "", neutral: "text-muted-foreground" };
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

export function StatementTab({
  page,
  sourceChips,
  source,
  periodChips,
  period,
  nextHref,
  startHref,
}: {
  page: StatementPage;
  sourceChips: readonly Chip[];
  source: string;
  periodChips: readonly Chip[];
  period: string;
  nextHref: string | null;
  startHref: string | null;
}) {
  return (
    <div className="space-y-4">
      <TabIntro>Tudo que entrou e saiu do seu dinheiro: saldo pré-pago, valores a receber e ajustes de conta.</TabIntro>
      <FilterChips label="Tipo de dinheiro" chips={sourceChips} active={source} />
      <FilterChips label="Período" chips={periodChips} active={period} />
      {page.lines.length === 0 ? (
        <EmptyState icon={ReceiptText} title="Nenhum lançamento neste período" description="Escolha outro período ou outro tipo de dinheiro." />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {page.lines.map((l) => (
              <li key={`${l.source}-${l.id}`}>
                <ListRow
                  icon={ICON[l.tone]}
                  title={l.title}
                  subtitle={`${dateFormat.format(l.at)} · ${l.detail}`}
                  value={<span className={cn(VALUE_CLASS[l.tone])}>{formatSignedMoney(l.amount)}</span>}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <MoreLinks nextHref={nextHref} startHref={startHref} />
    </div>
  );
}
