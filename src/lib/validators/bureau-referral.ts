import { z } from "zod";

// Mesmo formato do pct do sócio (numeric(5,2)); 0 é aceito (check da coluna: 0 a 100).
const referralPctField = z
	.string()
	.trim()
	.regex(/^\d{1,3}(\.\d{1,2})?$/, "Informe uma porcentagem de 0 a 100, com até 2 casas.")
	.refine((v) => Number(v) <= 100, "A porcentagem vai de 0 a 100.");

export const bureauReferrerSchema = z.object({
	referredBureauId: z.string().uuid("Bureau inválido."),
	referrerBureauId: z.string().uuid("Bureau indicador inválido."),
	pct: referralPctField.default("5"),
});
export type BureauReferrerInput = z.infer<typeof bureauReferrerSchema>;

export const clearBureauReferrerSchema = z.object({
	referredBureauId: z.string().uuid("Bureau inválido."),
});
export type ClearBureauReferrerInput = z.infer<typeof clearBureauReferrerSchema>;
