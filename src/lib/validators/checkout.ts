import { z } from "zod";

import { cardFieldsSchema, payerFieldsSchema } from "@/lib/validators/payer";
import { topupAmountSchema } from "@/lib/validators/wallet";

// Sem dependência de servidor: o formulário importa este arquivo.
// O total cobrado nunca vem do navegador: o servidor o calcula de amount + installments.
export const checkoutSchema = z
	.object({
		amount: topupAmountSchema,
		method: z.enum(["PIX", "CREDIT_CARD"]),
		payerKind: z.enum(["owner", "other"]),
		// Chave de idempotência gerada no navegador a cada envio; vira a referência externa da cobrança.
		idempotencyKey: z.string().uuid(),
		installments: z.number().int().min(1).max(12).optional(),
		payer: payerFieldsSchema.optional(),
		card: cardFieldsSchema.optional(),
		declaration: z.literal(true).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.method === "CREDIT_CARD" && !input.card) {
			ctx.addIssue({ code: "custom", path: ["card"], message: "Informe os dados do cartão." });
		}
		if (input.method === "PIX" && (input.card || (input.installments ?? 1) > 1)) {
			ctx.addIssue({ code: "custom", path: ["method"], message: "Cartão e parcelas só valem para pagamento no cartão." });
		}
		if (input.payerKind === "other" && !input.declaration) {
			ctx.addIssue({
				code: "custom",
				path: ["declaration"],
				message: "Confirme que os dados são de quem paga.",
			});
		}
	});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const checkoutContextSchema = z.object({
	scope: z.enum(["bureau", "client"]),
	amount: z.string().max(20),
});
