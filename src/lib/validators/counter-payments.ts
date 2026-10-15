import { z } from "zod";

import { moneySchema } from "./catalog";

export const COUNTER_METHODS = ["cash", "pix", "card_machine", "transfer", "other"] as const;

export const registerCounterPaymentSchema = z.object({
	dossierId: z.string().uuid("Dossiê inválido."),
	method: z.enum(COUNTER_METHODS, { errorMap: () => ({ message: "Forma de pagamento inválida." }) }),
	amount: moneySchema,
	note: z
		.string()
		.trim()
		.max(500, "Observação com no máximo 500 caracteres.")
		.nullish()
		.transform((v) => v || null),
	receivedAt: z.coerce.date({ errorMap: () => ({ message: "Data de recebimento inválida." }) }),
});

export const voidCounterPaymentSchema = z.object({
	id: z.string().uuid("Pagamento inválido."),
	reason: z.string().trim().min(1, "Informe o motivo da anulação.").max(500, "Motivo com no máximo 500 caracteres."),
});

export type RegisterCounterPaymentInput = z.infer<typeof registerCounterPaymentSchema>;
export type VoidCounterPaymentInput = z.infer<typeof voidCounterPaymentSchema>;
