import Link from "next/link";
import { Landmark, Smartphone } from "lucide-react";

import { SegmentedNav } from "@/components/ui/segmented-nav";
import { StatusBadge } from "@/components/ui/status-badge";
import { derivePaymentState, paymentMethodLabel, type PaymentFilter, PAYMENT_FILTERS, PAYMENT_FILTER_LABEL } from "@/lib/counter-payments/overview";
import type { PaymentOverviewRow } from "@/lib/counter-payments/queries";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDateSP } from "@/lib/utils";

// `basePath` + `baseParams` deixam a lista viver em outra rota (a aba da Carteira).
export function PaymentFilterChips({
  active,
  q,
  basePath = "/settings/counter-payments",
  baseParams = {},
}: {
  active: PaymentFilter;
  q: string;
  basePath?: string;
  baseParams?: Record<string, string>;
}) {
  const items = PAYMENT_FILTERS.map((f) => {
    const params = new URLSearchParams(baseParams);
    if (f !== "all") params.set("filter", f);
    if (q) params.set("q", q);
    const qs = params.toString();
    return { key: f, label: PAYMENT_FILTER_LABEL[f], href: `${basePath}${qs ? `?${qs}` : ""}` };
  });
  return <SegmentedNav label="Filtrar por forma de pagamento" items={items} activeKey={active} current="page" />;
}

export function PaymentOverviewList({ rows }: { rows: PaymentOverviewRow[] }) {
  if (rows.length === 0) return <p className="p-6 text-center text-sm text-muted-foreground">Nenhum pedido encontrado.</p>;
  return (
    <ul className="divide-y">
      {rows.map((r) => {
        const method = paymentMethodLabel(r.mode);
        const Icon = method.kind === "counter" ? Landmark : Smartphone;
        const pay = statusInfo("payment", derivePaymentState(r), "staff");
        return (
          <li key={r.dossierId}>
            <Link
              href={`/settings/counter-payments?dossier=${r.dossierId}`}
              className="flex min-h-14 flex-col gap-2 px-4 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="min-w-0">
                <span className="block truncate text-base font-bold">{r.subjectName}</span>
                <span className="block text-sm text-muted-foreground">
                  {formatDateSP(r.createdAt)}
                  {r.price !== null && ` · ${formatCurrency(Number(r.price))}`}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm font-bold">
                  <Icon aria-hidden className="size-4 shrink-0" />
                  {method.label}
                </span>
                <StatusBadge tone={pay.tone} label={pay.label} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
