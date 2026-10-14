import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Recibo de recarga" };

type Receipt = { id: string; amount: string; createdAt: Date; nfseUrl: string | null };

export default async function ReceiptPage({ params }: { params: { id: string } }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "credits:read") || !isUuid(params.id)) notFound();

  // Só o dono (o filtro e o RLS) e só cobrança paga. Só nfse_url sai: nenhuma outra coluna de NFS-e nem o id do Asaas.
  const receipt = await withUserTransaction(session, async (client) => {
    const { rows } = await client.query<{ id: string; amount: string; created_at: Date; nfse_url: string | null }>(
      `select id, amount, created_at, nfse_url from pix_charges
        where id = $1 and client_profile_id = $2 and status = 'paid'`,
      [params.id, session.userId],
    );
    const row = rows[0];
    return row ? ({ id: row.id, amount: row.amount, createdAt: row.created_at, nfseUrl: row.nfse_url } satisfies Receipt) : null;
  });
  if (!receipt) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title="Recibo de recarga" description="Pagamento confirmado por PIX" />
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div>
            <p className="text-sm text-muted-foreground">Valor</p>
            <p className="text-2xl font-semibold">{formatCurrency(Number(receipt.amount))}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Data da cobrança</p>
            <p className="text-lg">{formatDateTime(receipt.createdAt)}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-sm text-muted-foreground">Identificador da cobrança</p>
            <p className="break-all font-mono text-sm">{receipt.id}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-sm text-muted-foreground">Nota fiscal (NFS-e)</p>
            {receipt.nfseUrl ? (
              <a href={receipt.nfseUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">
                Abrir nota fiscal
              </a>
            ) : (
              <p className="text-sm">Nota em emissão</p>
            )}
          </div>
        </CardContent>
      </Card>
      <Link href="/portal/credits" className="inline-block text-sm underline">
        Voltar para créditos
      </Link>
    </div>
  );
}
