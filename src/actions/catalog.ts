"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import {
	createProduct as createProductQuery,
	createProductVersion as createProductVersionQuery,
	setBureauProductCost as setBureauProductCostQuery,
	updateProduct as updateProductQuery,
	upsertCatalogItem as upsertCatalogItemQuery,
	type CatalogConflict,
} from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";
import {
	bureauCostSchema,
	catalogItemSchema,
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
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para alterar produtos e custos.";

const CONFLICT_MESSAGES: Record<CatalogConflict, string> = {
	price_below_cost: "O preço de venda não pode ser menor que o custo.",
	cost_not_set: "O custo deste produto ainda não foi definido. Peça ao suporte para defini-lo.",
	addon_requires_main: "Ative antes um produto principal compatível com este adicional.",
	product_inactive: "Este produto está desativado.",
};

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

// Produto base, versão e custo por Bureau: só o superadmin (o bureau_admin também tem catalog:write).
// Fora de sessão de suporte: a auditoria dessas ações é de plataforma e não leva o suporte (decisão 5 do spec).
const requireProductManager = () =>
	requireSession((s) => s.role === "superadmin" && hasPermission(s, "catalog:write"), { denyInSupport: true });

const requireCostManager = () =>
	requireSession(
		(s) =>
			s.role === "superadmin" && hasPermission(s, "catalog:write") && hasPermission(s, "bureaus:manage"),
		{ denyInSupport: true },
	);

const requireCatalogAdmin = () =>
	requireSession((s) => s.role === "bureau_admin" && hasPermission(s, "catalog:write"));

export async function createProduct(values: unknown): Promise<CatalogActionResult> {
	const parsed = productCreateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireProductManager();
	if ("error" in gate) return { error: gate.error };
	const { session } = gate;

	let productId: string;
	try {
		const result = await createProductQuery(session, parsed.data);
		if (!result.ok) {
			return {
				error:
					result.reason === "code_taken"
						? "Este código já está em uso."
						: "Os produtos compatíveis devem existir e ser do tipo principal.",
			};
		}
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
		if (!result.ok) return { error: NOT_FOUND };
		versionId = result.versionId;
	} catch (error) {
		logFailure("createProductVersion", error);
		return { error: "Falha ao criar a versão do produto." };
	}
	revalidatePath("/superadmin/products");
	revalidatePath(`/superadmin/products/${parsed.data.productId}`);
	return { error: null, id: versionId };
}

export async function setBureauProductCost(values: unknown): Promise<CatalogActionResult> {
	const parsed = bureauCostSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireCostManager();
	if ("error" in gate) return { error: gate.error };
	const { session } = gate;

	try {
		const { bureauId, productId, cost } = parsed.data;
		const result = await setBureauProductCostQuery(session, bureauId, productId, cost);
		if (!result.ok) return { error: NOT_FOUND };
	} catch (error) {
		logFailure("setBureauProductCost", error);
		return { error: "Falha ao definir o custo." };
	}
	revalidatePath(`/superadmin/bureaus/${parsed.data.bureauId}`);
	// O custo novo muda o que o admin do Bureau vê e o que a vitrine mostra.
	revalidatePath("/settings/catalog");
	return { error: null, id: parsed.data.productId };
}

// O Bureau vem da sessão do bureau_admin, nunca do formulário.
export async function upsertCatalogItem(values: unknown): Promise<CatalogActionResult> {
	const parsed = catalogItemSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireCatalogAdmin();
	if ("error" in gate) return { error: gate.error };
	const { session } = gate;

	try {
		const { productId, active, salePrice } = parsed.data;
		const result = await upsertCatalogItemQuery(session, productId, { active, salePrice });
		if (!result.ok) return { error: result.reason === "not_found" ? NOT_FOUND : CONFLICT_MESSAGES[result.reason] };
	} catch (error) {
		logFailure("upsertCatalogItem", error);
		return { error: "Falha ao salvar o item do catálogo." };
	}
	revalidatePath("/settings/catalog");
	return { error: null, id: parsed.data.productId };
}
