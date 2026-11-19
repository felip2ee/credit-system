import { z } from "zod";

import { toCents } from "@/lib/catalog/money";

import { uuidSchema } from "./id";

export const COUPON_PRODUCT_CODES = ["dossie_pf", "dossie_empresarial"] as const;
const MAX_PERCENT_CENTS = 10_000; // 100,00 %
const MAX_INT = 2_147_483_647;

// Guardado em maiúsculas e sem espaços nas pontas (o banco repete a regra, mas aceita 3+: códigos antigos curtos seguem válidos).
export const couponCodeSchema = z
	.string()
	.transform((value) => value.trim().toUpperCase())
	.pipe(z.string().regex(/^[A-Z0-9_-]{6,32}$/, "Use de 6 a 32 letras, números, _ ou -."));

const limitSchema = z
	.number({ invalid_type_error: "Informe um número inteiro." })
	.int("Informe um número inteiro.")
	.positive("O limite deve ser maior que zero.")
	.max(MAX_INT, "Limite alto demais.")
	.nullable();

const dateSchema = z.coerce.date({ errorMap: () => ({ message: "Data inválida." }) });

const fields = {
	code: couponCodeSchema,
	kind: z.enum(["percent", "fixed"], { errorMap: () => ({ message: "Tipo de cupom inválido." }) }),
	// Percentual ou reais (fixo), como string decimal com até 2 casas.
	value: z.string(),
	allProducts: z.boolean(),
	productCodes: z.array(z.enum(COUPON_PRODUCT_CODES)).max(COUPON_PRODUCT_CODES.length).default([]),
	maxUses: limitSchema,
	// Ausente (undefined) usa o padrão; null é "ilimitado" explícito.
	maxUsesPerClient: limitSchema.optional(),
	validFrom: dateSchema.nullish().transform((v) => v ?? null),
	validUntil: dateSchema.nullish().transform((v) => v ?? null),
};

type Draft = {
	kind: "percent" | "fixed";
	value: string;
	allProducts: boolean;
	productCodes: string[];
	validFrom: Date | null;
	validUntil: Date | null;
};

function centsOrNull(value: string): number | null {
	try {
		return toCents(value);
	} catch {
		return null;
	}
}

function checkCoupon(v: Draft, ctx: z.RefinementCtx) {
	const cents = centsOrNull(v.value);
	if (cents === null || cents <= 0 || (v.kind === "percent" && cents > MAX_PERCENT_CENTS)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["value"],
			message:
				v.kind === "percent"
					? "Informe um percentual entre 0,01 e 100, com até 2 casas decimais."
					: "Informe um valor entre 0,01 e 99.999.999,99, com até 2 casas decimais.",
		});
	}
	if (!v.allProducts && v.productCodes.length === 0) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["productCodes"], message: "Escolha ao menos um produto." });
	}
	if (v.validFrom && v.validUntil && v.validUntil <= v.validFrom) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["validUntil"],
			message: "A validade deve ser depois do início.",
		});
	}
}

// Com limite total e sem limite por cliente informado, cada cliente usa 1 vez; sem limite total, ilimitado.
function withPerClientDefault<T extends { maxUses: number | null; maxUsesPerClient?: number | null }>(v: T) {
	return { ...v, maxUsesPerClient: v.maxUsesPerClient === undefined ? (v.maxUses === null ? null : 1) : v.maxUsesPerClient };
}

export const couponCreateSchema = z.object(fields).superRefine(checkCoupon).transform(withPerClientDefault);
export const couponUpdateSchema = z
	.object({ id: uuidSchema, ...fields })
	.superRefine(checkCoupon)
	.transform(withPerClientDefault);
export const couponActiveSchema = z.object({ id: uuidSchema, active: z.boolean() });

export type CouponCreate = z.infer<typeof couponCreateSchema>;
export type CouponUpdate = z.infer<typeof couponUpdateSchema>;
