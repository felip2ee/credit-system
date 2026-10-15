import { z } from "zod";

// O corte vale "até agora": um corte além de 2 dias é erro de digitação, não intenção.
export const MAX_CUTOFF_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;

export const createPayoutSchema = z.object({
	bureauId: z.string().uuid("Bureau inválido."),
	cutoffAt: z.coerce
		.date({ errorMap: () => ({ message: "Data de corte inválida." }) })
		.refine((date) => date.getTime() <= Date.now() + MAX_CUTOFF_AHEAD_MS, "Data de corte no futuro distante."),
});

export const payoutIdSchema = z.object({ payoutId: z.string().uuid("Repasse inválido.") });

export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;
