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

// Preço de venda da versão: vazio = versão sem preço ("não à venda", falha fechada).
const optionalSalePrice = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || null)
  .refine((value) => value === null || moneySchema.safeParse(value).success, {
    message: "Informe um valor entre 0,01 e 99.999.999,99, com até 2 casas decimais.",
  });

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
	salePrice: optionalSalePrice,
	salePricePerPartner: perPartnerMoney,
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
	salePrice: optionalSalePrice,
	salePricePerPartner: perPartnerMoney,
});

// % do Bureau: de 0 a 99,99 com até 2 casas (teto < 100: o balcão exige parte da plataforma > 0).
export const MAX_COMMISSION_PCT = 99.99;
const CENTS_EPSILON = 1e-9;

export const commissionPctSchema = z
	.number({ invalid_type_error: "Informe a porcentagem." })
	.min(0, "A porcentagem vai de 0 a 99,99.")
	.max(MAX_COMMISSION_PCT, "A porcentagem vai de 0 a 99,99.")
	.refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < CENTS_EPSILON, "Use até 2 casas decimais.");

export const bureauCommissionSchema = z.object({ pct: commissionPctSchema });

// pct nulo = volta à % global.
export const bureauCommissionOverrideSchema = z.object({
	bureauId: uuid,
	pct: commissionPctSchema.nullable(),
});

export const productBlockSchema = z.object({
	bureauId: uuid,
	productId: uuid,
	blocked: z.boolean(),
});

export type ProductCreate = z.infer<typeof productCreateSchema>;
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
export type ProductVersionInput = z.infer<typeof productVersionSchema>;
