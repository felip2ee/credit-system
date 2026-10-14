import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

const optionalString = z
	.string()
	.trim()
	.optional()
	.transform((v) => (v && v.length > 0 ? v : null));

const baseFields = {
	email: z
		.string()
		.trim()
		.email("E-mail inválido.")
		.optional()
		.or(z.literal(""))
		.transform((v) => (v ? v : null)),
	phone: optionalString,
	address: optionalString,
	addressNumber: optionalString,
	addressComplement: optionalString,
	neighborhood: optionalString,
	city: optionalString,
	state: z
		.string()
		.trim()
		.length(2, "UF com 2 letras.")
		.optional()
		.or(z.literal(""))
		.transform((v) => (v ? v.toUpperCase() : null)),
	zipCode: optionalString,
	notes: optionalString,
};

export const holderSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("PF"),
		name: z.string().trim().min(3, "Informe o nome completo."),
		document: z
			.string()
			.refine((v) => isValidCPF(v), "CPF inválido.")
			.transform(onlyDigits),
		...baseFields,
	}),
	z.object({
		type: z.literal("PJ"),
		name: z.string().trim().min(2, "Informe a razão social."),
		document: z
			.string()
			.refine((v) => isValidCNPJ(v), "CNPJ inválido.")
			.transform(onlyDigits),
		...baseFields,
	}),
]);

// Saída validada; casa com HolderInput de lib/holders/queries.
export type HolderParsed = z.infer<typeof holderSchema>;

// Schema do formulário (antes do transform) — usado pelo react-hook-form.
export const holderFormSchema = z.object({
	type: z.enum(["PF", "PJ"]),
	name: z.string().trim().min(2, "Campo obrigatório."),
	document: z.string().trim().min(1, "Documento obrigatório."),
	email: z.string().trim().email("E-mail inválido.").or(z.literal("")),
	phone: z.string().trim(),
	address: z.string().trim(),
	addressNumber: z.string().trim(),
	addressComplement: z.string().trim(),
	neighborhood: z.string().trim(),
	city: z.string().trim(),
	state: z.string().trim().max(2, "UF com 2 letras."),
	zipCode: z.string().trim(),
	notes: z.string().trim(),
});

export type HolderFormValues = z.infer<typeof holderFormSchema>;
