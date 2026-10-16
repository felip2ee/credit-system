import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

import { percentageSchema } from "./holder";
import { uuidSchema } from "./id";

const MAX_PARTNERS = 20;
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
const documentKind = (productCode: string): "PF" | "PJ" => (productCode === "consulta_pf" ? "PF" : "PJ");

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

// Pedido do cliente (portal). Própria: nome, documento e contato vêm da conta; o que o cliente digitou é descartado.
const clearThirdParty = (v: unknown) =>
	v && typeof v === "object" && (v as { self?: unknown }).self === true
		? { ...v, subject: null, contactEmail: null, contactPhone: null }
		: v;

export const clientOrderSchema = z
	.preprocess(
		clearThirdParty,
		z.object({
		productCode: z.enum(["consulta_pf", "consulta_pj"], { errorMap: () => ({ message: "Produto inválido." }) }),
		withAi: z.boolean(),
		self: z.boolean(),
		subject: subjectSchema.nullish(),
		contactEmail: optionalEmail,
		contactPhone: optionalPhone,
		}),
	)
	.superRefine((v, ctx) => {
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
	.transform((v) =>
		v.self || !v.subject
			? { productCode: v.productCode, withAi: v.withAi, self: v.self, subject: null, contactEmail: null, contactPhone: null }
			: {
					productCode: v.productCode,
					withAi: v.withAi,
					self: v.self,
					subject: toSubject(v.subject, v.productCode),
					contactEmail: v.contactEmail,
					contactPhone: v.contactPhone,
				},
	);

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

// Pedido de balcão (equipe). Sócios só no dossiê PJ completo.
export const counterOrderSchema = z
	.object({
		productCode: z.enum(["consulta_pf", "consulta_pj", "dossie_pj_completo"], {
			errorMap: () => ({ message: "Produto inválido." }),
		}),
		withAi: z.boolean().default(false),
		buyerProfileId: uuidSchema.nullish().transform((v) => v ?? null),
		subject: subjectSchema,
		contactEmail: optionalEmail,
		contactPhone: optionalPhone,
		partners: z.array(partnerSchema).max(MAX_PARTNERS, `No máximo ${MAX_PARTNERS} sócios.`).default([]),
	})
	.superRefine((v, ctx) => {
		checkSubject(v.subject, v.productCode, ctx, ["subject"]);
		if (v.partners.length > 0 && v.productCode !== "dossie_pj_completo") {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partners"], message: "Sócios só no dossiê PJ completo." });
		}
	})
	.transform((v) => ({
		productCode: v.productCode,
		withAi: v.withAi,
		buyerProfileId: v.buyerProfileId,
		subject: toSubject(v.subject, v.productCode),
		contactEmail: v.contactEmail,
		contactPhone: v.contactPhone,
		partners: v.partners.map((p) => ({
			documentDigits: onlyDigits(p.document),
			name: p.name,
			email: p.email,
			percentage: p.percentage,
			role: p.role,
		})),
	}));

export const orderIdSchema = uuidSchema;

export const revokeSchema = z.object({
	dossierId: uuidSchema,
	reason: z.string().trim().min(1, "Informe o motivo.").max(MAX_REASON, `Motivo com no máximo ${MAX_REASON} caracteres.`),
});

export type ClientOrderInput = z.infer<typeof clientOrderSchema>;
export type CounterOrderInput = z.infer<typeof counterOrderSchema>;
