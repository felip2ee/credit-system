"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import {
	createProduct as createProductQuery,
	createProductVersion as createProductVersionQuery,
	updateProduct as updateProductQuery,
	type CatalogConflict,
} from "@/lib/catalog/queries";
import {
	setBureauCommissionOverride as setBureauCommissionOverrideQuery,
	setProductBlock as setProductBlockQuery,
} from "@/lib/commission/queries";
import { hasPermission } from "@/lib/db/permissions";
import {
	bureauCommissionOverrideSchema,
	productBlockSchema,
	productCreateSchema,
	productUpdateSchema,
	productVersionSchema,
} from "@/lib/validators/catalog";

export interface CatalogActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar o catálogo.";
const NOT_FOUND = "Produto ou Bureau não encontrado.";
const SESSION_CHECK_FAILED = "Não foi possível verificar sua sessão. Tente novamente.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para alterar produtos, preços e comissões.";

const CONFLICT_MESSAGES: Record<CatalogConflict, string> = {
	price_below_cost: "O preço de venda não pode ser menor que o custo.",
	partner_price_below_cost: "O valor por sócio não pode ser menor que o custo por sócio.",
	per_partner_not_allowed: "O Dossiê Pessoa Física não cobra valor por sócio.",
};

const COMMISSION_FAILURES = {
	not_found: NOT_FOUND,
	split_over_100: "A comissão do Bureau somada à dos afiliados passa de 100%.",
} as const;

type Gate = { session: RequiredSession } | { error: string };

// Sessão inválida (SessionAccessError) vira "sem permissão"; qualquer outra falha (ex.: banco fora) vira falha genérica.
async function requireSession(
	allowed: (session: RequiredSession) => boolean,
	options: { denyInSupport?: boolean } = {},
): Promise<Gate> {
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("requireSession", error);
		return { error: SESSION_CHECK_FAILED };
	}
	if (!allowed(session)) return { error: NOT_ALLOWED };
	if (options.denyInSupport && (session.supportSessionId || session.support)) return { error: SUPPORT_ACTIVE };
	return { session };
}

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(action: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[catalog] ${action} falhou`, meta);
}

// Produto, versão e preço de venda: só o superadmin (o bureau_admin não tem catalog:write desde 055).
// Fora de sessão de suporte: a auditoria dessas ações é de plataforma e não leva o suporte (decisão 5 do spec).
const requireProductManager = () =>
	requireSession((s) => s.role === "superadmin" && hasPermission(s, "catalog:write"), { denyInSupport: true });

// Comissão e bloqueio de produto por Bureau.
const requireBureauManager = () =>
	requireSession((s) => s.role === "superadmin" && hasPermission(s, "bureaus:manage"), { denyInSupport: true });

export async function createProduct(values: unknown): Promise<CatalogActionResult> {
	const parsed = productCreateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireProductManager();
	if ("error" in gate) return { error: gate.error };
	const { session } = gate;

	let productId: string;
	try {
		const result = await createProductQuery(session, parsed.data);
		if (!result.ok) return { error: result.reason === "code_taken" ? "Este código já está em uso." : CONFLICT_MESSAGES[result.reason] };
		productId = result.id;
	} catch (error) {
		logFailure("createProduct", error);
		return { error: "Falha ao criar o produto." };
	}
	revalidatePath("/superadmin/products");
	return { error: null, id: productId };
}

export async function updateProduct(values: unknown): Promise<CatalogActionResult> {
	const parsed = productUpdateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireProductManager();
	if ("error" in gate) return { error: gate.error };
	const { session } = gate;

	try {
		const result = await updateProductQuery(session, parsed.data);
		if (!result.ok) return { error: NOT_FOUND };
	} catch (error) {
		logFailure("updateProduct", error);
		return { error: "Falha ao salvar o produto." };
	}
	revalidatePath("/superadmin/products");
	revalidatePath(`/superadmin/products/${parsed.data.id}`);
	return { error: null, id: parsed.data.id };
}

export async function createProductVersion(values: unknown): Promise<CatalogActionResult> {
	const parsed = productVersionSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireProductManager();
	if ("error" in gate) return { error: gate.error };
	const { session } = gate;

	let versionId: string;
	try {
		const result = await createProductVersionQuery(session, parsed.data);
		if (!result.ok) return { error: result.reason === "not_found" ? NOT_FOUND : CONFLICT_MESSAGES[result.reason] };
		versionId = result.versionId;
	} catch (error) {
		logFailure("createProductVersion", error);
		return { error: "Falha ao criar a versão do produto." };
	}
	revalidatePath("/superadmin/products");
	revalidatePath(`/superadmin/products/${parsed.data.productId}`);
	return { error: null, id: versionId };
}

export async function setBureauCommissionOverrideAction(values: unknown): Promise<CatalogActionResult> {
	const parsed = bureauCommissionOverrideSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireBureauManager();
	if ("error" in gate) return { error: gate.error };

	try {
		const result = await setBureauCommissionOverrideQuery(gate.session, parsed.data.bureauId, parsed.data.pct);
		if (!result.ok) return { error: COMMISSION_FAILURES[result.reason] };
	} catch (error) {
		logFailure("setBureauCommissionOverride", error);
		return { error: "Falha ao definir a comissão do Bureau." };
	}
	revalidatePath(`/superadmin/bureaus/${parsed.data.bureauId}`);
	// A % nova muda o que o admin do Bureau vê.
	revalidatePath("/settings/catalog");
	return { error: null, id: parsed.data.bureauId };
}

export async function setProductBlockAction(values: unknown): Promise<CatalogActionResult> {
	const parsed = productBlockSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireBureauManager();
	if ("error" in gate) return { error: gate.error };

	try {
		const { bureauId, productId, blocked } = parsed.data;
		const result = await setProductBlockQuery(gate.session, bureauId, productId, blocked);
		if (!result.ok) return { error: COMMISSION_FAILURES[result.reason] };
	} catch (error) {
		logFailure("setProductBlock", error);
		return { error: "Falha ao salvar o bloqueio do produto." };
	}
	revalidatePath(`/superadmin/bureaus/${parsed.data.bureauId}`);
	revalidatePath("/settings/catalog");
	return { error: null, id: parsed.data.productId };
}
