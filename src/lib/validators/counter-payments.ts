import { z } from "zod";

import { moneySchema } from "./catalog";
import { idempotencyKeySchema } from "./id";

export const COUNTER_METHODS = ["cash", "pix", "card_machine", "transfer", "other"] as const;

// Data civil de Brasília (o balcão vive nesse fuso). Formato AAAA-MM-DD: null ou número nunca viram 1970.
const MIN_RECEIVED_ON = "2000-01-01";
const RECEIVED_AT_INVALID = "Data de recebimento inválida.";
const todayInSaoPaulo = (): string =>
	new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

const receivedAtSchema = z
	.string({ errorMap: () => ({ message: RECEIVED_AT_INVALID }) })
	.regex(/^\d{4}-\d{2}-\d{2}$/, RECEIVED_AT_INVALID)
	.refine((value) => {
		const date = new Date(`${value}T00:00:00Z`);
		return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
	}, RECEIVED_AT_INVALID)
	.refine((value) => value >= MIN_RECEIVED_ON, RECEIVED_AT_INVALID)
	.refine((value) => value <= todayInSaoPaulo(), "A data de recebimento não pode ser futura.")
	.transform((value) => new Date(`${value}T00:00:00Z`));

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
	receivedAt: receivedAtSchema,
	idempotencyKey: idempotencyKeySchema,
});

export const voidCounterPaymentSchema = z.object({
	id: z.string().uuid("Pagamento inválido."),
	reason: z.string().trim().min(1, "Informe o motivo da anulação.").max(500, "Motivo com no máximo 500 caracteres."),
});

export type RegisterCounterPaymentInput = z.infer<typeof registerCounterPaymentSchema>;
export type VoidCounterPaymentInput = z.infer<typeof voidCounterPaymentSchema>;
