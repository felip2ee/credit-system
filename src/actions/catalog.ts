"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
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

const CONFLICT_MESSAGES: Record<CatalogConflict, string> = {
	price_below_cost: "O preço de venda não pode ser menor que o custo.",
	cost_not_set: "O custo deste produto ainda não foi definido. Peça ao suporte para defini-lo.",
	addon_requires_main: "Ative antes um produto principal compatível com este adicional.",
	product_inactive: "Este produto está desativado.",
};

async function requireSession(
	allowed: (session: RequiredSession) => boolean,
): Promise<RequiredSession | null> {
	try {
		const session = await getRequiredSession();
		return allowed(session) ? session : null;
	} catch {
		return null;
	}
}

// Produto base, versão e custo por Bureau: só o superadmin (o bureau_admin também tem catalog:write).
const requireProductManager = () =>
	requireSession((s) => s.role === "superadmin" && hasPermission(s, "catalog:write"));

const requireCostManager = () =>
	requireSession(
		(s) =>
			s.role === "superadmin" && hasPermission(s, "catalog:write") && hasPermission(s, "bureaus:manage"),
	);

const requireCatalogAdmin = () =>
	requireSession((s) => s.role === "bureau_admin" && hasPermission(s, "catalog:write"));

export async function createProduct(values: unknown): Promise<CatalogActionResult> {
	const parsed = productCreateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const session = await requireProductManager();
	if (!session) return { error: NOT_ALLOWED };

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
		revalidatePath("/superadmin/products");
		return { error: null, id: result.id };
	} catch {
		return { error: "Falha ao criar o produto." };
	}
}

export async function updateProduct(values: unknown): Promise<CatalogActionResult> {
	const parsed = productUpdateSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const session = await requireProductManager();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const result = await updateProductQuery(session, parsed.data);
		if (!result.ok) return { error: NOT_FOUND };
	} catch {
		return { error: "Falha ao salvar o produto." };
	}
	revalidatePath("/superadmin/products");
	revalidatePath(`/superadmin/products/${parsed.data.id}`);
	return { error: null, id: parsed.data.id };
}

export async function createProductVersion(values: unknown): Promise<CatalogActionResult> {
	const parsed = productVersionSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const session = await requireProductManager();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const result = await createProductVersionQuery(session, parsed.data);
		if (!result.ok) return { error: NOT_FOUND };
		revalidatePath("/superadmin/products");
		revalidatePath(`/superadmin/products/${parsed.data.productId}`);
		return { error: null, id: result.versionId };
	} catch {
		return { error: "Falha ao criar a versão do produto." };
	}
}

export async function setBureauProductCost(values: unknown): Promise<CatalogActionResult> {
	const parsed = bureauCostSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const session = await requireCostManager();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const { bureauId, productId, cost } = parsed.data;
		const result = await setBureauProductCostQuery(session, bureauId, productId, cost);
		if (!result.ok) return { error: NOT_FOUND };
	} catch {
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
	const session = await requireCatalogAdmin();
	if (!session) return { error: NOT_ALLOWED };

	try {
		const { productId, active, salePrice } = parsed.data;
		const result = await upsertCatalogItemQuery(session, productId, { active, salePrice });
		if (!result.ok) return { error: result.reason === "not_found" ? NOT_FOUND : CONFLICT_MESSAGES[result.reason] };
	} catch {
		return { error: "Falha ao salvar o item do catálogo." };
	}
	revalidatePath("/settings/catalog");
	return { error: null, id: parsed.data.productId };
}
