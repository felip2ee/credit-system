import Link from "next/link";
import { redirect } from "next/navigation";

import { StackedList, StackedRow } from "@/components/dashboard/stacked-list";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listWithdrawalQueue } from "@/lib/affiliates/withdrawals";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listBureauMetrics } from "@/lib/bureaus/queries";
import { formatCurrency, formatDateTime } from "@/lib/utils";

export const metadata = { title: "Saques de afiliados" };

export default async function WithdrawalQueuePage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "withdrawals:manage") || session.supportSessionId || session.support) {
    return (
      <div className="space-y-6">
        <PageHeader title="Saques" description="Saques de comissão de afiliados" />
        <p className="text-sm text-muted-foreground">Encerre a sessão de suporte para ver os saques.</p>
      </div>
    );
  }

  const [queue, bureaus] = await Promise.all([listWithdrawalQueue(session, "open"), listBureauMetrics(session)]);
  const bureauNames = new Map(bureaus.map((b) => [b.bureauId, b.name]));

  return (
    <div className="space-y-6">
      <PageHeader title="Saques" description="Saques de comissão em aberto, do mais antigo ao mais novo" />
      {queue.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum saque em aberto.</p>
      ) : (
        <Card className="overflow-hidden">
        <StackedList>
          {queue.map((w) => (
            <StackedRow
              key={w.id}
              title={w.holderName}
              meta={[
                bureauNames.get(w.bureauId) ?? "—",
                `Pedido em ${formatDateTime(w.createdAt)}`,
                `Valor ${formatCurrency(Number(w.amount))} · Taxa ${formatCurrency(Number(w.fee))}`,
                `Chave PIX ${w.pixKeyMasked}`,
              ].join(" · ")}
              aside={formatCurrency(Number(w.net))}
            >
              <Button asChild size="sm" variant="outline">
                <Link href={`/superadmin/saques/${w.id}`} aria-label={`Abrir saque de ${w.holderName}`}>
                  Abrir
                </Link>
              </Button>
            </StackedRow>
          ))}
        </StackedList>
        <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pedido em</TableHead>
              <TableHead>Bureau</TableHead>
              <TableHead>Afiliada</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead>Taxa</TableHead>
              <TableHead>Líquido</TableHead>
              <TableHead>Chave PIX</TableHead>
              <TableHead>Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.map((w) => (
              <TableRow key={w.id}>
                <TableCell>{formatDateTime(w.createdAt)}</TableCell>
                <TableCell>{bureauNames.get(w.bureauId) ?? "—"}</TableCell>
                <TableCell>{w.holderName}</TableCell>
                <TableCell>{formatCurrency(Number(w.amount))}</TableCell>
                <TableCell>{formatCurrency(Number(w.fee))}</TableCell>
                <TableCell className="font-semibold">{formatCurrency(Number(w.net))}</TableCell>
                <TableCell className="font-mono text-sm">{w.pixKeyMasked}</TableCell>
                <TableCell>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/superadmin/saques/${w.id}`} aria-label={`Abrir saque de ${w.holderName}`}>
                      Abrir
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        </Card>
      )}
    </div>
  );
}
