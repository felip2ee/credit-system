"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requestMeta } from "@/lib/account/request-meta";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { getPublicCatalog } from "@/lib/bureaus/public";
import { toCents } from "@/lib/catalog/money";
import { buildQuote } from "@/lib/catalog/quote";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { toE164 } from "@/lib/notifications/recipient";
import { CLIENT_ORDER_MESSAGES, ORDER_FAILED } from "@/lib/orders/failure-messages";
import { cancelMyOrder } from "@/lib/orders/client-ops";
import { getMyHolderType } from "@/lib/orders/client-queries";
import { placeOrder, type PlaceOrderOptions } from "@/lib/orders/queries";
import type { OpenOrderInput } from "@/lib/orders/types";
import type { OrderQuote } from "@/lib/settlement/types";
import { clientOrderSchema, orderIdSchema } from "@/lib/validators/order";

export interface ActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Ação não permitida.";
const INVALID_PHONE = "Celular inválido. Use DDD e número.";
// Mesma trava de e-mail da recarga (credits-topup). Os termos só eram checados no layout do portal; a action chamada direto passava.
const EMAIL_NOT_VERIFIED = "Confirme seu e-mail antes de comprar créditos.";
const TERMS_NOT_ACCEPTED = "Aceite os termos de uso antes de fazer um pedido.";
const DECLARATION_REQUIRED = "Marque a declaração para continuar.";
const ORDER_NOT_FOUND = "Pedido não encontrado.";

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

// D26: o cliente não lê a tabela do catálogo. Preço de venda vem do catálogo público do Bureau; o custo é do banco
// (reserve_order recalcula preço e custo pelo pedido e confere o total).
async function quoteFromPublicCatalog(
	session: RequiredSession,
	productCode: string,
	partnerCount: number,
): Promise<OrderQuote | { ok: false; reason: "product_not_for_sale" }> {
	const { rows } = await withUserTransaction(session, (client) =>
		client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()"),
	);
	if (!rows[0]) throw new Error("bureau slug not found");
	const catalog = await getPublicCatalog(rows[0].slug);
	const product = catalog.find((item) => item.code === productCode);
	if (!product) return { ok: false, reason: "product_not_for_sale" };
	return {
		ok: true,
		...buildQuote(
			{
				productVersionId: "",
				code: product.code,
				salePriceCents: toCents(product.salePrice),
				salePricePerPartnerCents: toCents(product.salePricePerPartner),
				costCents: 0,
				costPerPartnerCents: 0,
			},
			partnerCount,
		),
	};
}

// Pedido "com membros": envolve CPFs de outras pessoas (sócios ou o responsável da empresa). Exige a declaração do comprador.
async function hasMembers(
	session: RequiredSession,
	order: { productCode: string; self: boolean },
): Promise<boolean> {
	if (order.productCode === "dossie_empresarial") return true;
	if (order.self) return false;
	const holderType = await withUserTransaction(session, (client) => getMyHolderType(client, session.userId));
	return holderType === "PJ";
}

// A versão é a que o cliente viu no formulário: o banco recusa (declaration_outdated) se o texto mudou depois.
async function declarationOptions(version: number): Promise<PlaceOrderOptions> {
	const { ip, userAgent } = requestMeta(await headers());
	return { declaration: { version, ip, userAgent } };
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
		const withMembers = await hasMembers(session, parsed.data);
		if (withMembers && !parsed.data.declarationAccepted) return { error: DECLARATION_REQUIRED };
		if (withMembers && parsed.data.declarationVersion === null) return { error: CLIENT_ORDER_MESSAGES.declaration_outdated };
		const quote = await quoteFromPublicCatalog(session, parsed.data.productCode, parsed.data.partners.length);
		if (!quote.ok) return { error: CLIENT_ORDER_MESSAGES[quote.reason] };
		const input: OpenOrderInput = {
			productCode: parsed.data.productCode,
			self: parsed.data.self,
			subject: parsed.data.subject,
			partners: parsed.data.partners,
			contact: { email: parsed.data.contactEmail, phoneE164 },
			buyerProfileId: null,
		};
		const { declarationVersion } = parsed.data;
		const options = withMembers && declarationVersion !== null ? await declarationOptions(declarationVersion) : undefined;
		const result = await placeOrder(session, input, quote, options);
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

export async function cancelMyOrderAction(dossierId: unknown): Promise<ActionResult> {
	const id = orderIdSchema.safeParse(dossierId);
	if (!id.success) return { error: ORDER_NOT_FOUND };

	const session = await requireClient();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const result = await withUserTransaction(session, (client) => cancelMyOrder(client, id.data));
		if (!result.ok) return { error: CLIENT_ORDER_MESSAGES[result.reason] ?? ORDER_FAILED };
		revalidatePath("/portal/pesquisas");
		revalidatePath(`/portal/pesquisas/${id.data}`);
		return { error: null, id: id.data };
	} catch (error) {
		logFailure("cancelMyOrderAction", error);
		return { error: ORDER_FAILED };
	}
}
