"use server";

import { revalidatePath } from "next/cache";

import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { getPublicCatalog } from "@/lib/bureaus/public";
import { toCents } from "@/lib/catalog/money";
import { AI_ADDON_CODE } from "@/lib/catalog/quote";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { toE164 } from "@/lib/notifications/recipient";
import { CLIENT_ORDER_MESSAGES, ORDER_FAILED } from "@/lib/orders/failure-messages";
import { placeOrder } from "@/lib/orders/queries";
import type { OpenOrderInput } from "@/lib/orders/types";
import type { OrderQuote } from "@/lib/settlement/types";
import { clientOrderSchema } from "@/lib/validators/order";

export interface ActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Ação não permitida.";
const INVALID_PHONE = "Celular inválido. Use DDD e número.";
// Mesma trava de e-mail da recarga (credits-topup). Os termos só eram checados no layout do portal; a action chamada direto passava.
const EMAIL_NOT_VERIFIED = "Confirme seu e-mail antes de comprar créditos.";
const TERMS_NOT_ACCEPTED = "Aceite os termos de uso antes de fazer um pedido.";

// Só nome do passo e motivo: nunca documento, contato nem a mensagem do driver.
function logFailure(step: string, detail: unknown): void {
	const meta =
		detail instanceof Error
			? { name: detail.name, code: "code" in detail ? detail.code : undefined }
			: typeof detail === "string"
				? { reason: detail }
				: { name: typeof detail };
	console.error(`[orders] ${step} falhou`, meta);
}

// Só o próprio cliente compra no portal. Equipe e superadmin em suporte nunca abrem pedido online.
async function requireClient(): Promise<RequiredSession | null> {
	try {
		const session = await getRequiredSession();
		return session.role === "client" && hasPermission(session, "portal:write") ? session : null;
	} catch {
		return null;
	}
}

// D26: o cliente não lê a tabela do catálogo. Preço de venda vem do catálogo público do Bureau; o custo é do banco.
async function quoteFromPublicCatalog(
	session: RequiredSession,
	productCode: string,
	withAi: boolean,
): Promise<OrderQuote | { ok: false; reason: "product_not_for_sale" | "addon_not_for_sale" }> {
	const { rows } = await withUserTransaction(session, (client) =>
		client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()"),
	);
	if (!rows[0]) throw new Error("bureau slug not found");
	const catalog = await getPublicCatalog(rows[0].slug);
	const main = catalog.find((item) => item.code === productCode && item.kind === "main");
	if (!main) return { ok: false, reason: "product_not_for_sale" };
	const items = [main];
	if (withAi) {
		const addon = catalog.find((item) => item.code === AI_ADDON_CODE && item.kind === "addon");
		if (!addon) return { ok: false, reason: "addon_not_for_sale" };
		items.push(addon);
	}
	const lines = items.map((item) => ({
		code: item.code,
		priceCents: toCents(item.salePrice),
		costCents: 0,
		productVersionId: "",
	}));
	return { ok: true, lines, totalCostCents: 0, totalPriceCents: lines.reduce((sum, l) => sum + l.priceCents, 0) };
}

export async function openClientOrderAction(values: unknown): Promise<ActionResult> {
	const parsed = clientOrderSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	const session = await requireClient();
	if (!session) return { error: NOT_ALLOWED };

	const phoneE164 = parsed.data.contactPhone === null ? null : toE164(parsed.data.contactPhone);
	if (parsed.data.contactPhone !== null && !phoneE164) return { error: INVALID_PHONE };

	try {
		const status = await withUserTransaction(session, (client) => getClientAccountStatus(client, session.userId));
		if (!status.termsAccepted) return { error: TERMS_NOT_ACCEPTED };
		if (!status.emailVerified) return { error: EMAIL_NOT_VERIFIED };
		const quote = await quoteFromPublicCatalog(session, parsed.data.productCode, parsed.data.withAi);
		if (!quote.ok) return { error: CLIENT_ORDER_MESSAGES[quote.reason] };
		const input: OpenOrderInput = {
			productCode: parsed.data.productCode,
			withAi: parsed.data.withAi,
			self: parsed.data.self,
			subject: parsed.data.subject,
			partners: [],
			contact: { email: parsed.data.contactEmail, phoneE164 },
			buyerProfileId: null,
		};
		const result = await placeOrder(session, input, quote);
		if (!result.ok) {
			const message = CLIENT_ORDER_MESSAGES[result.reason];
			if (!message) logFailure("openClientOrderAction", result.reason);
			return { error: message ?? ORDER_FAILED };
		}
		revalidatePath("/portal/pesquisas");
		return { error: null, id: result.dossierId };
	} catch (error) {
		logFailure("openClientOrderAction", error);
		return { error: ORDER_FAILED };
	}
}
