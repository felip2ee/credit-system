"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { computeCouponDiscount, eligibleTotalCents } from "@/lib/coupons/discount";
import {
	createCoupon as createCouponQuery,
	previewCoupon,
	setCouponActive as setCouponActiveQuery,
	updateCoupon as updateCouponQuery,
	type CouponConflict,
} from "@/lib/coupons/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { COUPON_INVALID, ORDER_FAILED } from "@/lib/orders/failure-messages";
import { quoteFromPublicCatalog } from "@/lib/orders/public-quote";
import { MAX_PARTNERS } from "@/lib/validators/order";
import {
	COUPON_PRODUCT_CODES,
	couponActiveSchema,
	couponCreateSchema,
	couponUpdateSchema,
} from "@/lib/validators/coupons";

export interface CouponActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar cupons.";
const CLIENT_NOT_ALLOWED = "Ação não permitida.";
const INVALID = "Dados inválidos.";
const SETTINGS_PATH = "/settings/cupons";

const CONFLICT_MESSAGES: Record<CouponConflict, string> = {
	code_taken: "Já existe um cupom com este código.",
	product_not_found: "Produto não encontrado.",
	invalid_period: "A validade deve ser depois do início.",
	not_found: "Cupom não encontrado.",
};

// Só o admin do Bureau gerencia cupons. Sessão inválida e falta de permissão dão a mesma resposta.
async function requireCouponAdmin(): Promise<RequiredSession | null> {
	try {
		const session = await getRequiredSession();
		return session.role === "bureau_admin" && hasPermission(session, "coupons:write") ? session : null;
	} catch {
		return null;
	}
}

// Só nome e código do erro: sem código de cupom nem dado de cliente.
function logFailure(action: string, error: unknown): void {
	const meta =
		error instanceof Error ? { name: error.name, code: "code" in error ? error.code : undefined } : { name: typeof error };
	console.error(`[coupons] ${action} falhou`, meta);
}

export async function createCouponAction(values: unknown): Promise<CouponActionResult> {
	const parsed = couponCreateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? INVALID };
	const session = await requireCouponAdmin();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const result = await createCouponQuery(session, parsed.data);
		if (!result.ok) return { error: CONFLICT_MESSAGES[result.reason] };
		revalidatePath(SETTINGS_PATH);
		return { error: null, id: result.id };
	} catch (error) {
		logFailure("createCouponAction", error);
		return { error: "Falha ao criar o cupom." };
	}
}

export async function updateCouponAction(values: unknown): Promise<CouponActionResult> {
	const parsed = couponUpdateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? INVALID };
	const session = await requireCouponAdmin();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const result = await updateCouponQuery(session, parsed.data);
		if (!result.ok) return { error: CONFLICT_MESSAGES[result.reason] };
		revalidatePath(SETTINGS_PATH);
		return { error: null, id: result.id };
	} catch (error) {
		logFailure("updateCouponAction", error);
		return { error: "Falha ao salvar o cupom." };
	}
}

export async function setCouponActiveAction(values: unknown): Promise<CouponActionResult> {
	const parsed = couponActiveSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? INVALID };
	const session = await requireCouponAdmin();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const result = await setCouponActiveQuery(session, parsed.data);
		if (!result.ok) return { error: CONFLICT_MESSAGES[result.reason] };
		revalidatePath(SETTINGS_PATH);
		return { error: null, id: parsed.data.id };
	} catch (error) {
		logFailure("setCouponActiveAction", error);
		return { error: "Falha ao alterar o cupom." };
	}
}

export interface CouponPreviewResult {
	error: string | null;
	listCents?: number;
	discountCents?: number;
	paidCents?: number;
}

// Código com formato solto de propósito: formato errado e código desconhecido dão a mesma resposta.
const couponPreviewSchema = z.object({
	productCode: z.enum(COUPON_PRODUCT_CODES),
	// Só a quantidade de sócios entra no preço; os dados dos sócios não passam por aqui.
	partners: z.number().int().min(0).max(MAX_PARTNERS),
	couponCode: z.string().max(64),
});

async function requireClient(): Promise<RequiredSession | null> {
	try {
		const session = await getRequiredSession();
		return session.role === "client" && hasPermission(session, "portal:write") ? session : null;
	} catch {
		return null;
	}
}

// Prévia do preço com cupom. Não grava nada: só lê o preço público e consulta coupon_preview. A reserva (reserve_order)
// decide de novo e confere o preço pago.
export async function previewCouponAction(values: unknown): Promise<CouponPreviewResult> {
	const parsed = couponPreviewSchema.safeParse(values);
	if (!parsed.success) return { error: COUPON_INVALID };
	const session = await requireClient();
	if (!session) return { error: CLIENT_NOT_ALLOWED };

	try {
		const quote = await quoteFromPublicCatalog(session, parsed.data.productCode, parsed.data.partners);
		if (!quote.ok) return { error: COUPON_INVALID };
		const preview = await withUserTransaction(session, (client) =>
			previewCoupon(client, parsed.data.couponCode, [parsed.data.productCode]),
		);
		if (!preview) return { error: COUPON_INVALID };
		const { discountCents } = computeCouponDiscount({
			kind: preview.kind,
			value: preview.value,
			eligibleTotalCents: eligibleTotalCents(quote.lines, preview.eligibleProductCodes),
		});
		return {
			error: null,
			listCents: quote.totalPriceCents,
			discountCents,
			paidCents: quote.totalPriceCents - discountCents,
		};
	} catch (error) {
		logFailure("previewCouponAction", error);
		return { error: ORDER_FAILED };
	}
}
