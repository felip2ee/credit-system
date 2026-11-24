import { redirect } from "next/navigation";

import { GenerateLinkButton } from "@/components/admin/generate-link-button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StateTone } from "@/components/ui/state-tone";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { listPaymentLinks, type PaymentLinkListItem } from "@/lib/payment-links/queries";
import { formatCurrency, formatDateTime } from "@/lib/utils";

type View = { label: string; tone: StateTone; renewable: boolean };

// Link ativo cujo prazo passou continua 'active' no banco até alguém marcá-lo: a tela mostra como expirado.
function viewOf(link: PaymentLinkListItem, now: number): View {
  if (link.status === "paid") return { label: "Pago", tone: "success", renewable: false };
  if (link.status === "cancelled") return { label: "Cancelado", tone: "neutral", renewable: false };
  if (link.status === "expired" || link.expiresAt.getTime() <= now) return { label: "Expirado", tone: "danger", renewable: true };
  return { label: "Ativo", tone: "waiting", renewable: true };
}

export default async function AdminChargesPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!session.bureauId) redirect("/login");

  const [bureau, links] = await Promise.all([getBureau(session, session.bureauId), listPaymentLinks(session)]);
  const now = Date.now();

  return (
    <div className="space-y-5">
      <PageHeader title="Cobranças" description="Links de pagamento enviados aos clientes" />
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum link de pagamento ainda. Abra uma consulta em &ldquo;Nova consulta&rdquo;.</p>
      ) : (
        <ul className="space-y-3">
          {links.map((l) => {
            const view = viewOf(l, now);
            return (
              <li key={l.id}>
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{l.holderName}</p>
                        <p className="text-sm text-muted-foreground">{l.maskedDocument}</p>
                      </div>
                      <StatusBadge tone={view.tone} label={view.label} className="shrink-0" />
                    </div>
                    <p className="text-sm">
                      {l.productName}
                      {l.amount !== null && <span className="font-bold tabular-nums"> · {formatCurrency(Number(l.amount))}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {l.status === "paid" ? "Criado" : "Vence"} em {formatDateTime(l.status === "paid" ? l.createdAt : l.expiresAt)}
                    </p>
                    {view.renewable && (
                      <GenerateLinkButton orderId={l.orderId} bureauName={bureau?.name ?? "Bureau"} productName={l.productName} label="Gerar novo link" />
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
