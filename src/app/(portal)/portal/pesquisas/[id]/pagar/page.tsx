import { randomUUID } from "node:crypto";

import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";

import { OrderPixPanel, type QrCharge } from "@/components/orders/order-pix-panel";
import { orderPixView } from "@/components/orders/order-pix-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getOrderPayment } from "@/lib/orders/order-pix";
import { formatDateTime } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Pagar pedido" };
export const dynamic = "force-dynamic";

const QR_WIDTH = 208;

export default async function PayOrderPage({ params }: { params: { id: string } }) {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (session.role !== "client" || !hasPermission(session, "portal:write")) redirect("/portal");
	if (!isUuid(params.id)) notFound();

	const payment = await withUserTransaction(session, (client) => getOrderPayment(client, params.id));
	if (!payment) notFound();

	const view = orderPixView(payment, new Date());
	if (view === "leave") redirect(`/portal/pesquisas/${params.id}`);

	const { charge } = payment;
	const qr: QrCharge | null =
		view === "show_qr" && charge?.pixPayload
			? {
					id: charge.id,
					pixPayload: charge.pixPayload,
					qrDataUrl: await QRCode.toDataURL(charge.pixPayload, { margin: 1, width: QR_WIDTH }),
					expiresAt: charge.expiresAt.toISOString(),
					expiresLabel: formatDateTime(charge.expiresAt),
					priceCents: charge.amountCents,
					feeCents: charge.feeCents,
					totalCents: charge.totalCents,
				}
			: null;

	return (
		<div className="space-y-6">
			<ScreenHeader className="-mx-4 min-[375px]:-mx-5" title="Pagar com PIX" backHref={`/portal/pesquisas/${params.id}`} backLabel="Voltar ao pedido" />
			<p className="text-sm text-muted-foreground">Pague o PIX para iniciar a pesquisa. O pedido segue sozinho depois do pagamento.</p>
			<OrderPixPanel view={view} dossierId={params.id} priceCents={payment.priceCents} idempotencyKey={randomUUID()} charge={qr} />
		</div>
	);
}
