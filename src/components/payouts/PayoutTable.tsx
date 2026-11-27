import { CancelPayoutButton } from "@/components/payouts/CancelPayoutButton";
import { MarkPaidForm } from "@/components/payouts/MarkPaidForm";
import { PAYOUT_STATUS_LABEL, PAYOUT_STATUS_TONE } from "@/components/payouts/payout-labels";
import { StackedList, StackedRow } from "@/components/dashboard/stacked-list";
import { StatusBadge } from "@/components/ui/status-badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Payout } from "@/lib/payouts/queries";
import { formatCurrency, formatDateSP, formatDateTime } from "@/lib/utils";

interface PayoutTableProps {
  payouts: Payout[];
  // Nome do Bureau por id; sem o mapa a coluna Bureau não aparece (visão do próprio Bureau).
  bureauNames?: Record<string, string>;
  canManage?: boolean;
  // Lista empilhada abaixo de `md`. Só a tela do superadmin liga; a carteira do Bureau segue só com a tabela.
  stacked?: boolean;
}

function RowActions({ payout, bureauName }: { payout: Payout; bureauName: string }) {
  const cutoff = formatDateSP(payout.cutoffAt);
  return (
    <div className="space-y-2">
      <MarkPaidForm payoutId={payout.id} bureauName={bureauName} cutoff={cutoff} amount={formatCurrency(Number(payout.amount))} />
      <CancelPayoutButton payoutId={payout.id} summary={`${bureauName}, corte ${cutoff}`} />
    </div>
  );
}

function ReceiptLink({ payout }: { payout: Payout }) {
  return (
    <a href={`/api/payouts/${payout.id}/receipt`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
      Baixar comprovante
    </a>
  );
}

export function PayoutTable({ payouts, bureauNames, canManage = false, stacked = false }: PayoutTableProps) {
  if (payouts.length === 0) return <p className="text-sm text-muted-foreground">Nenhum repasse ainda.</p>;
  return (
    <Card className="overflow-hidden">
    {stacked && (
      <StackedList>
        {payouts.map((payout) => {
          const bureauName = bureauNames?.[payout.bureauId] ?? "Bureau";
          const hasReceipt = payout.status === "paid" && payout.hasReceipt;
          const showActions = canManage && payout.status === "open";
          return (
            <StackedRow
              key={payout.id}
              title={bureauName}
              meta={`Corte ${formatDateSP(payout.cutoffAt)}${payout.paidAt ? ` · Pago em ${formatDateTime(payout.paidAt)}` : ""}`}
              status={<StatusBadge tone={PAYOUT_STATUS_TONE[payout.status]} label={PAYOUT_STATUS_LABEL[payout.status]} />}
              aside={formatCurrency(Number(payout.amount))}
            >
              {hasReceipt && <ReceiptLink payout={payout} />}
              {showActions && <RowActions payout={payout} bureauName={bureauName} />}
            </StackedRow>
          );
        })}
      </StackedList>
    )}
    <div className={stacked ? "hidden md:block" : undefined}>
      <Table>
        <TableHeader>
          <TableRow>
            {bureauNames && <TableHead>Bureau</TableHead>}
            <TableHead>Corte</TableHead>
            <TableHead>Valor</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Pago em</TableHead>
            <TableHead>Comprovante</TableHead>
            {canManage && <TableHead>Ações</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {payouts.map((payout) => (
            <TableRow key={payout.id}>
              {bureauNames && <TableCell>{bureauNames[payout.bureauId] ?? "—"}</TableCell>}
              <TableCell>{formatDateSP(payout.cutoffAt)}</TableCell>
              <TableCell>{formatCurrency(Number(payout.amount))}</TableCell>
              <TableCell>
                <StatusBadge tone={PAYOUT_STATUS_TONE[payout.status]} label={PAYOUT_STATUS_LABEL[payout.status]} />
              </TableCell>
              <TableCell>{formatDateTime(payout.paidAt)}</TableCell>
              <TableCell>
                {payout.status === "paid" && payout.hasReceipt ? (
                  <ReceiptLink payout={payout} />
                ) : (
                  "—"
                )}
              </TableCell>
              {canManage && (
                <TableCell>
                  {payout.status === "open" && (
                    <RowActions payout={payout} bureauName={bureauNames?.[payout.bureauId] ?? "Bureau"} />
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    </Card>
  );
}
