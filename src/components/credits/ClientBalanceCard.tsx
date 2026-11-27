import { AdjustBalanceDialog } from "@/components/credits/AdjustBalanceDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CLIENT_KIND_LABEL, clientLedgerAmount } from "@/components/credits/client-ledger-labels";
import { formatCurrency } from "@/lib/utils";
import type { ClientLedgerEntry, ClientWalletBalance } from "@/lib/wallet/client-queries";

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

interface ClientBalanceCardProps {
  holderId: string;
  wallet: ClientWalletBalance;
  rows: ClientLedgerEntry[];
  // adjustment id -> nome de quem ajustou; o lançamento aponta para ele em "adjustment:<id>".
  authors: Record<string, string>;
  // Presente só com credits:adjust.
  bureauAvailable: string | null;
  // Máximo que o Bureau pode remover agora; presente só com credits:adjust.
  maxDebit: string;
}

const authorOf = (row: ClientLedgerEntry, authors: Record<string, string>): string | null =>
  row.reference?.startsWith("adjustment:") ? (authors[row.reference.slice("adjustment:".length)] ?? null) : null;

export function ClientBalanceCard({ holderId, wallet, rows, authors, bureauAvailable, maxDebit }: ClientBalanceCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-lg">Saldo do cliente</CardTitle>
        {bureauAvailable !== null && (
          <AdjustBalanceDialog holderId={holderId} bureauAvailable={bureauAvailable} maxDebit={maxDebit} />
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">Disponível</dt>
            <dd className="text-2xl font-semibold">{formatCurrency(Number(wallet.available))}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Reservado</dt>
            <dd className="text-2xl font-semibold">{formatCurrency(Number(wallet.reserved))}</dd>
          </div>
        </dl>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum lançamento ainda.</p>
        ) : (
          <Table scrollLabel="Lançamentos do saldo do cliente">
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Disponível após</TableHead>
                <TableHead>Motivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const author = authorOf(row, authors);
                return (
                  <TableRow key={row.id}>
                    <TableCell>{dateFormat.format(new Date(row.createdAt))}</TableCell>
                    <TableCell>{CLIENT_KIND_LABEL[row.kind]}</TableCell>
                    <TableCell>{clientLedgerAmount(row.kind, row.amount)}</TableCell>
                    <TableCell>{formatCurrency(Number(row.availableAfter))}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.reason ?? "—"}
                      {author && <span className="block text-sm">por {author}</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
