import { z } from "zod";

// Número de 0 a 100 com até 2 casas, como texto (vai direto para numeric(5,2) sem perda).
export const affiliatePctField = z
	.string()
	.trim()
	.regex(/^\d{1,3}(\.\d{1,2})?$/, "Informe uma porcentagem de 0 a 100, com até 2 casas.")
	.refine((v) => Number(v) <= 100, "A porcentagem vai de 0 a 100.");

export const bureauAffiliatePctSchema = z.object({
	bureauId: z.string().uuid("Bureau inválido."),
	pct: affiliatePctField,
});
