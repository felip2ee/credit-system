import { z } from "zod";

import { toCents } from "@/lib/catalog/money";

// Valor em reais como string decimal, > 0 e <= 99999999.99.
export const moneySchema = z.string().refine((value) => {
	try {
		return toCents(value) > 0;
	} catch {
		return false;
	}
}, "Informe um valor entre 0,01 e 99.999.999,99, com até 2 casas decimais.");

// Custo e valor por sócio aceitam 0: o Dossiê Pessoa Física não cobra por sócio.
export const nonNegativeMoneySchema = z.string().refine((value) => {
	try {
		return toCents(value) >= 0;
	} catch {
		return false;
	}
}, "Informe um valor entre 0,00 e 99.999.999,99, com até 2 casas decimais.");

const perPartnerMoney = nonNegativeMoneySchema.default("0.00");

const productName = z
	.string()
	.trim()
	.min(1, "Informe o nome do produto.")
	.max(120, "Nome com no máximo 120 caracteres.");

const depsProduct = z
	.string()
	.trim()
	.max(120, "Nome DEPS com no máximo 120 caracteres.")
	.default("")
	.transform((value) => value || null);

const uuid = z.string().uuid();

export const productCreateSchema = z.object({
	code: z.string().regex(/^[a-z0-9_]{3,60}$/, "Use de 3 a 60 letras minúsculas, números ou _."),
	name: productName,
	depsProduct,
	baseCost: nonNegativeMoneySchema,
	baseCostPerPartner: perPartnerMoney,
});

export const productUpdateSchema = z.object({
	id: uuid,
	name: productName,
	active: z.boolean(),
});

export const productVersionSchema = z.object({
	productId: uuid,
	depsProduct,
	baseCost: nonNegativeMoneySchema,
	baseCostPerPartner: perPartnerMoney,
});

export const bureauCostSchema = z.object({
	bureauId: uuid,
	productId: uuid,
	cost: nonNegativeMoneySchema,
	costPerPartner: perPartnerMoney,
});

export const catalogItemSchema = z.object({
	productId: uuid,
	active: z.boolean(),
	salePrice: moneySchema,
	salePricePerPartner: perPartnerMoney,
});

export type ProductCreate = z.infer<typeof productCreateSchema>;
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
export type ProductVersionInput = z.infer<typeof productVersionSchema>;
export type BureauCostInput = z.infer<typeof bureauCostSchema>;
export type CatalogItemInput = z.infer<typeof catalogItemSchema>;
