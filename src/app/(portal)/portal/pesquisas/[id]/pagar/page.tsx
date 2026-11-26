import { randomUUID } from "node:crypto";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { OrderPixPanel, type QrCharge } from "@/components/orders/order-pix-panel";
import { orderPixView } from "@/components/orders/order-pix-view";
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
		<div className="space-y-4">
			<Link href={`/portal/pesquisas/${params.id}`} className="inline-flex min-h-12 items-center gap-1 font-bold text-primary hover:underline">
				<ArrowLeft aria-hidden className="size-5" />
				Voltar ao pedido
			</Link>
			<PageHeader title="Pagar com PIX" description="Pague o PIX para iniciar a pesquisa. O pedido segue sozinho depois do pagamento." />
			<OrderPixPanel view={view} dossierId={params.id} priceCents={payment.priceCents} idempotencyKey={randomUUID()} charge={qr} />
		</div>
	);
}
