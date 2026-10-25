import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { WithdrawalActions } from "@/components/affiliates/withdrawal-actions";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { statusInfo } from "@/lib/ui/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getWithdrawalDetail, type PixKeyType } from "@/lib/affiliates/withdrawals";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Saque de afiliada" };

const KEY_TYPE_LABEL: Record<PixKeyType, string> = {
  document: "CPF/CNPJ",
  email: "E-mail",
  phone: "Telefone",
  random: "Chave aleatória",
};

export default async function WithdrawalDetailPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound();
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "withdrawals:manage") || session.supportSessionId || session.support) {
    return (
      <div className="space-y-6">
        <PageHeader title="Saque" description="Saque de comissão de afiliada" />
        <p className="text-sm text-muted-foreground">Encerre a sessão de suporte para ver o saque.</p>
      </div>
    );
  }

  // Esta leitura grava withdrawal.view: a chave completa só sai aqui, nunca na fila.
  const w = await getWithdrawalDetail(session, params.id);
  if (!w) notFound();

  const rows: [string, React.ReactNode][] = [
    ["Valor", formatCurrency(Number(w.amount))],
    ["Taxa", formatCurrency(Number(w.fee))],
    ["Líquido a pagar", <strong key="net">{formatCurrency(Number(w.net))}</strong>],
    ["Pedido em", formatDateTime(w.createdAt)],
  ];
  if (w.paidAt) rows.push(["Pago em", formatDateTime(w.paidAt)]);
  if (w.cancelReason) rows.push(["Motivo do cancelamento", w.cancelReason]);
  if (w.status === "paid") rows.push(["Comprovante", w.receiptObjectKey ? "Anexado" : "—"]);

  return (
    <div className="space-y-6">
      <PageHeader title="Saque de afiliada" description={w.holderName}>
        <StatusBadge tone={statusInfo("withdrawal", w.status, "staff").tone} label={statusInfo("withdrawal", w.status, "staff").label} />
        <Link href="/superadmin/saques" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Voltar à fila
        </Link>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pagamento por PIX</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Titular da conta</dt>
            <dd className="font-medium">{w.holderName}</dd>
            <dt className="text-muted-foreground">Tipo da chave</dt>
            <dd>{KEY_TYPE_LABEL[w.pixKeyType]}</dd>
            {w.accountDocumentMasked && (
              <>
                <dt className="text-muted-foreground">Documento da conta</dt>
                <dd className="font-mono">{w.accountDocumentMasked}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Chave PIX</dt>
            <dd className="break-all font-mono">{w.pixKey}</dd>
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p role="note" className="rounded-card border border-border bg-muted p-3 text-base">
            Confira no banco se o nome do favorecido é o mesmo da conta.
          </p>
        </CardContent>
      </Card>

      <WithdrawalActions withdrawalId={w.id} status={w.status} net={formatCurrency(Number(w.net))} />
    </div>
  );
}
