import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

import { percentageSchema } from "./holder";

const optionalEmail = z
	.string()
	.trim()
	.email("E-mail inválido.")
	.or(z.literal(""))
	.nullish()
	.transform((v) => v || null);

const optionalText = z
	.string()
	.trim()
	.nullish()
	.transform((v) => v || null);

const partnerSchema = z.object({
	cpf: z.string().transform(onlyDigits),
	name: optionalText,
	email: optionalEmail,
	percentage: percentageSchema.nullish().transform((v) => v ?? null),
	role: optionalText,
});

export const createDossierSchema = z
	.object({
		kind: z.enum(["PF", "PJ", "PJ_FULL"], {
			errorMap: () => ({ message: "Tipo de Dossiê inválido." }),
		}),
		document: z.string().transform(onlyDigits),
		name: optionalText,
		email: optionalEmail,
		partners: z.array(partnerSchema).default([]),
		scrMode: z
			.enum(["internal", "deps"], { errorMap: () => ({ message: "Modo SCR inválido." }) })
			.default("internal"),
	})
	.transform((v) => ({
		...v,
		// Sócios só valem no PJ_FULL; linha sem CPF é descartada.
		partners: v.kind === "PJ_FULL" ? v.partners.filter((p) => p.cpf) : [],
	}))
	.superRefine((v, ctx) => {
		const valid = v.kind === "PF" ? isValidCPF(v.document) : isValidCNPJ(v.document);
		if (!valid) ctx.addIssue({ code: "custom", path: ["document"], message: "Documento inválido." });
		v.partners.forEach((p, i) => {
			if (!isValidCPF(p.cpf)) {
				ctx.addIssue({ code: "custom", path: ["partners", i, "cpf"], message: "CPF de sócio inválido." });
			}
		});
	});

export type CreateDossierParsed = z.infer<typeof createDossierSchema>;
