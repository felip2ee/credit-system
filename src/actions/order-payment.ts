"use server";

import { headers } from "next/headers";

import { requestMeta } from "@/lib/account/request-meta";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { fromCents } from "@/lib/catalog/money";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getOrderPayment } from "@/lib/orders/order-pix";
import { runCheckout, type CheckoutActionResult } from "@/lib/payments/checkout";
import { checkoutSchema } from "@/lib/validators/checkout";
import { orderPixSchema } from "@/lib/validators/order";

const NOT_ALLOWED = "Ação não permitida.";
const NOT_FOUND = "Pedido não encontrado.";
const NOT_AWAITING = "Este pedido não aguarda pagamento.";
const GENERATING = "O PIX está sendo gerado. Aguarde um instante.";
const EXPIRED = "O PIX venceu. O pedido será cancelado.";
const ALREADY_PAID = "Pagamento já recebido.";
const FAILED = "Não foi possível gerar o PIX. Tente novamente.";
const DESCRIPTION = "Pedido de pesquisa";

// Só o próprio cliente paga o pedido dele no portal (mesma regra de orders-client.ts).
async function requireClient(): Promise<RequiredSession | null> {
	try {
		const session = await getRequiredSession();
		return session.role === "client" && hasPermission(session, "portal:write") ? session : null;
	} catch {
		return null;
	}
}

// Cria o PIX do pedido. O valor é o preço guardado na cotação (order_pix_quotes): o navegador não manda valor nem método.
export async function createOrderPixAction(values: unknown): Promise<CheckoutActionResult> {
	const parsed = orderPixSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	const session = await requireClient();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const { dossierId, ...rest } = parsed.data;
		const payment = await withUserTransaction(session, (client) => getOrderPayment(client, dossierId));
		if (!payment) return { error: NOT_FOUND };
		if (payment.state !== "awaiting_payment") return { error: NOT_AWAITING };

		const { charge } = payment;
		if (charge?.status === "pending") {
			if (!charge.pixPayload) return { error: GENERATING };
			return { error: null, id: charge.id, method: "PIX", reused: true };
		}
		if (charge?.status === "expired") return { error: EXPIRED };
		if (charge?.status === "paid") return { error: ALREADY_PAID };

		const input = checkoutSchema.safeParse({ ...rest, amount: fromCents(payment.priceCents), method: "PIX" });
		if (!input.success) return { error: input.error.issues[0]?.message ?? NOT_ALLOWED };

		const { ip } = requestMeta(await headers());
		return await runCheckout(
			session,
			{ kind: "client", clientProfileId: session.userId, orderId: dossierId },
			input.data,
			{ remoteIp: ip ?? "", description: DESCRIPTION },
		);
	} catch (error) {
		console.error("[orders] createOrderPixAction falhou", { name: error instanceof Error ? error.name : typeof error });
		return { error: FAILED };
	}
}
