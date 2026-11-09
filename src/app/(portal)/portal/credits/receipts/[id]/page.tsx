import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { nfseNoteFor } from "@/lib/nfse/receipt-note";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Recibo de recarga" };

type Receipt = {
  id: string;
  amount: string;
  feeAmount: string;
  totalCharged: string | null;
  createdAt: Date;
  nfseStatus: string;
  nfseUrl: string | null;
};

export default async function ReceiptPage({ params }: { params: { id: string } }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "credits:read") || !isUuid(params.id)) notFound();

  // Só o dono (o filtro e o RLS) e só cobrança paga. Só nfse_status e nfse_url saem: nenhuma outra coluna de NFS-e nem o id do Asaas.
  const receipt = await withUserTransaction(session, async (client) => {
    const { rows } = await client.query<{
      id: string;
      amount: string;
      fee_amount: string;
      total_charged: string | null;
      created_at: Date;
      nfse_status: string;
      nfse_url: string | null;
    }>(
      `select id, amount, fee_amount, total_charged, created_at, nfse_status, nfse_url from pix_charges
        where id = $1 and client_profile_id = $2 and status = 'paid'`,
      [params.id, session.userId],
    );
    const row = rows[0];
    return row
      ? ({
          id: row.id,
          amount: row.amount,
          feeAmount: row.fee_amount,
          totalCharged: row.total_charged,
          createdAt: row.created_at,
          nfseStatus: row.nfse_status,
          nfseUrl: row.nfse_url,
        } satisfies Receipt)
      : null;
  });
  if (!receipt) notFound();
  const note = nfseNoteFor(receipt.nfseStatus, receipt.nfseUrl);

  return (
    <div className="space-y-6">
      <PageHeader title="Recibo de recarga" description="Pagamento confirmado por PIX" />
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Valor</p>
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(Number(receipt.amount))}</p>
          </div>
          {receipt.totalCharged !== null && Number(receipt.feeAmount) > 0 && (
            <div>
              <p className="text-muted-foreground">Taxa e total pago</p>
              <p className="text-lg tabular-nums">
                Taxa {formatCurrency(Number(receipt.feeAmount))} · Total {formatCurrency(Number(receipt.totalCharged))}
              </p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground">Data da cobrança</p>
            <p className="text-lg">{formatDateTime(receipt.createdAt)}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-muted-foreground">Identificador da cobrança</p>
            <p className="break-all font-mono">{receipt.id}</p>
          </div>
          {note && (
            <div className="sm:col-span-2">
              <p className="text-muted-foreground">Nota fiscal (NFS-e)</p>
              {note.kind === "link" ? (
                <a href={note.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center font-bold text-primary underline">
                  Abrir nota fiscal
                </a>
              ) : (
                <p>{note.text}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Link href="/portal/credits" className="inline-flex min-h-12 items-center font-bold text-primary underline">
        Voltar para créditos
      </Link>
    </div>
  );
}
