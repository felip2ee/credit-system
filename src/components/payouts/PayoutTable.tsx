import { CancelPayoutButton } from "@/components/payouts/CancelPayoutButton";
import { MarkPaidForm } from "@/components/payouts/MarkPaidForm";
import { PAYOUT_STATUS_LABEL, PAYOUT_STATUS_TONE } from "@/components/payouts/payout-labels";
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
}

export function PayoutTable({ payouts, bureauNames, canManage = false }: PayoutTableProps) {
  if (payouts.length === 0) return <p className="text-sm text-muted-foreground">Nenhum repasse ainda.</p>;
  return (
    <Card className="overflow-hidden">
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
                <a
                  href={`/api/payouts/${payout.id}/receipt`}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Baixar comprovante
                </a>
              ) : (
                "—"
              )}
            </TableCell>
            {canManage && (
              <TableCell>
                {payout.status === "open" && (
                  <div className="space-y-2">
                    <MarkPaidForm
                      payoutId={payout.id}
                      bureauName={bureauNames?.[payout.bureauId] ?? "Bureau"}
                      cutoff={formatDateSP(payout.cutoffAt)}
                      amount={formatCurrency(Number(payout.amount))}
                    />
                    <CancelPayoutButton
                      payoutId={payout.id}
                      summary={`${bureauNames?.[payout.bureauId] ?? "Bureau"}, corte ${formatDateSP(payout.cutoffAt)}`}
                    />
                  </div>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </Card>
  );
}
