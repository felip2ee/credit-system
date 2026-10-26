import { PaymentFilterChips, PaymentOverviewList } from "@/components/counter-payments/PaymentOverviewList";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { RequiredSession } from "@/lib/auth/session";
import { parsePaymentFilter } from "@/lib/counter-payments/overview";
import { listPaymentOverview } from "@/lib/counter-payments/queries";
import { withUserTransaction } from "@/lib/db/transaction";

interface Props {
  session: RequiredSession;
  filterParam?: string;
  qParam?: string;
  // Rota que hospeda a lista; `baseParams` entram em cada link e no formulário de busca.
  basePath?: string;
  baseParams?: Record<string, string>;
}

// Busca, filtros e lista de pagamentos por pedido. O chamador já checou `counter:read`.
export async function CounterPaymentsOverview({
  session,
  filterParam,
  qParam,
  basePath = "/settings/counter-payments",
  baseParams = {},
}: Props) {
  const filter = parsePaymentFilter(filterParam);
  const q = qParam?.trim() ?? "";
  const rows = await withUserTransaction(session, (client) =>
    listPaymentOverview(client, { mode: filter === "all" ? null : filter === "client" ? "online" : "counter", q }),
  );
  return (
    <div className="space-y-6">
      <form action={basePath} className="flex max-w-md gap-2">
        {Object.entries(baseParams).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        <Input
          name="q"
          aria-label="Buscar por nome, CPF ou CNPJ"
          placeholder="Buscar por nome, CPF ou CNPJ..."
          defaultValue={qParam ?? ""}
        />
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>
      <PaymentFilterChips active={filter} q={q} basePath={basePath} baseParams={baseParams} />
      <Card>
        <CardContent className="p-0">
          <PaymentOverviewList rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
