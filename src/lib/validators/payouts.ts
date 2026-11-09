import { z } from "zod";

// O corte vale "até agora": um corte além de 2 dias é erro de digitação, não intenção.
export const MAX_CUTOFF_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;

const CUTOFF_INVALID = "Data de corte inválida.";

export const createPayoutSchema = z.object({
	bureauId: z.string().uuid("Bureau inválido."),
	// Ausente = a ação usa now() − retenção. A união recusa null, vazio e número antes da conversão (new Date(null) é 1970).
	cutoffAt: z
		.union([z.string().trim().min(1), z.date()], { errorMap: () => ({ message: CUTOFF_INVALID }) })
		.transform((value) => new Date(value))
		.refine((date) => !Number.isNaN(date.getTime()), CUTOFF_INVALID)
		.refine((date) => date.getTime() <= Date.now() + MAX_CUTOFF_AHEAD_MS, "Data de corte no futuro distante.")
		.optional(),
});

export const payoutIdSchema = z.object({ payoutId: z.string().uuid("Repasse inválido.") });

export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;
