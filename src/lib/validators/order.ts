import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

import { percentageSchema } from "./holder";
import { uuidSchema } from "./id";
import { payerFieldsSchema } from "./payer";

export const MAX_PARTNERS = 20;
const MAX_REASON = 500;

const nameSchema = z.string().trim().min(2, "Informe o nome.").max(120, "Nome com no máximo 120 caracteres.");
const subjectSchema = z.object({ name: nameSchema, document: z.string().trim().min(1, "Informe o documento.") });
const emailSchema = z.string().trim().email("E-mail inválido.").max(254, "E-mail muito longo.");
const phoneSchema = z.string().trim().max(30, "Celular com no máximo 30 caracteres.");
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Máximo de ${max} caracteres.`)
		.nullish()
		.transform((v) => (v ? v : null));

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalEmail = z.preprocess(blank, emailSchema.nullish()).transform((v) => v ?? null);
const optionalPhone = z.preprocess(blank, phoneSchema.nullish()).transform((v) => v ?? null);

type Subject = z.infer<typeof subjectSchema>;
const documentKind = (productCode: string): "PF" | "PJ" => (productCode === "dossie_pf" ? "PF" : "PJ");

function checkSubject(subject: Subject, productCode: string, ctx: z.RefinementCtx, path: (string | number)[]) {
	const valid = documentKind(productCode) === "PF" ? isValidCPF(subject.document) : isValidCNPJ(subject.document);
	if (!valid) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [...path, "document"],
			message: documentKind(productCode) === "PF" ? "CPF inválido." : "CNPJ inválido.",
		});
	}
}

const toSubject = (subject: Subject, productCode: string) => ({
	type: documentKind(productCode),
	name: subject.name,
	documentDigits: onlyDigits(subject.document),
});

// D9: um consentimento por membro. O e-mail do sócio é obrigatório; o contato da empresa nunca vale por ele.
const partnerEmailSchema = z
	.string({ required_error: "Informe o e-mail do sócio." })
	.trim()
	.min(1, "Informe o e-mail do sócio.")
	.email("E-mail do sócio inválido.")
	.max(254, "E-mail muito longo.");

const partnerSchema = z.object({
	document: z.string().refine(isValidCPF, "CPF do sócio inválido."),
	name: nameSchema,
	email: partnerEmailSchema,
	percentage: percentageSchema.nullish().transform((v) => v ?? null),
	role: optionalText(100),
});

// O mesmo CPF duas vezes conta um sócio só (como open_order): a cotação precisa casar com o total que o banco recalcula.
const toPartners = (partners: z.infer<typeof partnerSchema>[]) => {
	const seen = new Set<string>();
	return partners.flatMap((p) => {
		const documentDigits = onlyDigits(p.document);
		if (seen.has(documentDigits)) return [];
		seen.add(documentDigits);
		return [{ documentDigits, name: p.name, email: p.email, percentage: p.percentage, role: p.role }];
	});
};

const ORDER_PRODUCT_CODES = ["dossie_pf", "dossie_empresarial"] as const;
const productCodeSchema = z.enum(ORDER_PRODUCT_CODES, { errorMap: () => ({ message: "Produto inválido." }) });
const PARTNERS_ONLY_EMPRESARIAL = "Sócios só no Dossiê Empresarial.";

// Pedido do cliente (portal). Própria: nome, documento e contato vêm da conta; o que o cliente digitou é descartado.
const clearThirdParty = (v: unknown) =>
	v && typeof v === "object" && (v as { self?: unknown }).self === true
		? { ...v, subject: null, contactEmail: null, contactPhone: null }
		: v;

export const clientOrderSchema = z
	.preprocess(
		clearThirdParty,
		z.object({
		productCode: productCodeSchema,
		self: z.boolean(),
		subject: subjectSchema.nullish(),
		contactEmail: optionalEmail,
		contactPhone: optionalPhone,
		partners: z.array(partnerSchema).max(MAX_PARTNERS, `No máximo ${MAX_PARTNERS} sócios.`).default([]),
		declarationAccepted: z.boolean().default(false),
		// A versão do texto que o formulário mostrou. O banco recusa se já não for a vigente.
		declarationVersion: z.number().int().positive().nullish().transform((v) => v ?? null),
		// Formato solto de propósito: código inválido e código de formato errado dão a mesma resposta ("Cupom inválido ou indisponível").
		couponCode: z.string().max(64).nullish().transform((v) => v?.trim().toUpperCase() || null),
		}),
	)
	.superRefine((v, ctx) => {
		if (v.partners.length > 0 && v.productCode !== "dossie_empresarial") {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partners"], message: PARTNERS_ONLY_EMPRESARIAL });
		}
		if (v.self) return;
		if (!v.subject) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: "Informe quem será pesquisado." });
		} else {
			checkSubject(v.subject, v.productCode, ctx, ["subject"]);
		}
		if (v.contactEmail === null) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contactEmail"], message: "Informe o e-mail do titular." });
		}
	})
	.transform((v) => ({
		productCode: v.productCode,
		self: v.self,
		subject: v.self || !v.subject ? null : toSubject(v.subject, v.productCode),
		contactEmail: v.self || !v.subject ? null : v.contactEmail,
		contactPhone: v.self || !v.subject ? null : v.contactPhone,
		partners: toPartners(v.partners),
		declarationAccepted: v.declarationAccepted,
		declarationVersion: v.declarationVersion,
		couponCode: v.couponCode,
	}));

// Pedido de balcão (equipe). Sócios só no Dossiê Empresarial.
export const counterOrderSchema = z
	.object({
		productCode: productCodeSchema,
		buyerProfileId: uuidSchema.nullish().transform((v) => v ?? null),
		subject: subjectSchema,
		contactEmail: optionalEmail,
		contactPhone: optionalPhone,
		partners: z.array(partnerSchema).max(MAX_PARTNERS, `No máximo ${MAX_PARTNERS} sócios.`).default([]),
	})
	.superRefine((v, ctx) => {
		checkSubject(v.subject, v.productCode, ctx, ["subject"]);
		if (v.partners.length > 0 && v.productCode !== "dossie_empresarial") {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partners"], message: PARTNERS_ONLY_EMPRESARIAL });
		}
	})
	.transform((v) => ({
		productCode: v.productCode,
		buyerProfileId: v.buyerProfileId,
		subject: toSubject(v.subject, v.productCode),
		contactEmail: v.contactEmail,
		contactPhone: v.contactPhone,
		partners: toPartners(v.partners),
	}));

export const orderIdSchema = uuidSchema;

// PIX do pedido. Sem valor nem método: o preço vem da cotação guardada no servidor e o método é sempre PIX.
export const orderPixSchema = z.object({
	dossierId: uuidSchema,
	idempotencyKey: z.string().uuid(),
	payerKind: z.enum(["owner", "other"]).default("owner"),
	payer: payerFieldsSchema.optional(),
	declaration: z.literal(true).optional(),
});

// Correção do contato do pedido de autorização. E-mail e celular em branco = manter o atual (reenvio). Para o próprio
// Titular do comprador o servidor usa o e-mail da conta e descarta o que for digitado.
export const updateOrderContactSchema = z.object({
	dossierId: uuidSchema,
	consultationId: uuidSchema,
	contactEmail: optionalEmail,
	contactPhone: optionalPhone,
});

export const revokeSchema = z.object({
	dossierId: uuidSchema,
	reason: z.string().trim().min(1, "Informe o motivo.").max(MAX_REASON, `Motivo com no máximo ${MAX_REASON} caracteres.`),
});

export type ClientOrderInput = z.infer<typeof clientOrderSchema>;
export type CounterOrderInput = z.infer<typeof counterOrderSchema>;
