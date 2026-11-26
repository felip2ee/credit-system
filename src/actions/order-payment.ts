"use server";

import { headers } from "next/headers";

import { requestMeta } from "@/lib/account/request-meta";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { fromCents } from "@/lib/catalog/money";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getOrderPayment, type OrderPixCharge } from "@/lib/orders/order-pix";
import { runCheckout, type CheckoutActionResult } from "@/lib/payments/checkout";
import { checkoutSchema } from "@/lib/validators/checkout";
import { orderPixSchema } from "@/lib/validators/order";

const NOT_ALLOWED = "Ação não permitida.";
const NOT_FOUND = "Pedido não encontrado.";
const NOT_AWAITING = "Este pedido não aguarda pagamento.";
const GENERATING = "O PIX está sendo gerado. Aguarde um instante.";
const EXPIRED = "O PIX venceu. O pedido será cancelado.";
const REFUNDED = "O PIX foi estornado. O pedido será cancelado.";
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

// Cobrança que já decide a resposta (sem criar outra): viva, vencida, estornada ou paga. Recusada (cancelled) ou ausente: null.
// Estornada vale como vencida (D4: um PIX vivo por pedido, sem PIX novo); a mensagem não diz que venceu.
function settledResult(charge: OrderPixCharge | null): CheckoutActionResult | null {
	if (charge?.status === "pending") {
		return charge.pixPayload ? { error: null, id: charge.id, method: "PIX", reused: true } : { error: GENERATING };
	}
	if (charge?.status === "expired") return { error: EXPIRED };
	if (charge?.status === "refunded") return { error: REFUNDED };
	if (charge?.status === "paid") return { error: ALREADY_PAID };
	return null;
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

		const settled = settledResult(payment.charge);
		if (settled) return settled;

		const input = checkoutSchema.safeParse({ ...rest, amount: fromCents(payment.priceCents), method: "PIX" });
		if (!input.success) return { error: input.error.issues[0]?.message ?? NOT_ALLOWED };

		const { ip } = requestMeta(await headers());
		const result = await runCheckout(
			session,
			{ kind: "client", clientProfileId: session.userId, orderId: dossierId },
			input.data,
			{ remoteIp: ip ?? "", description: DESCRIPTION },
		);
		if (!result.error) return result;
		// Dois envios ao mesmo tempo (duas abas): o segundo bate no índice único de cobrança viva do pedido (23505) e
		// runCheckout devolve erro genérico. Relê o pedido: se o outro envio já criou o PIX, esta tela usa essa cobrança.
		const after = await withUserTransaction(session, (client) => getOrderPayment(client, dossierId));
		return after?.charge?.status === "pending" ? (settledResult(after.charge) ?? result) : result;
	} catch (error) {
		console.error("[orders] createOrderPixAction falhou", { name: error instanceof Error ? error.name : typeof error });
		return { error: FAILED };
	}
}
