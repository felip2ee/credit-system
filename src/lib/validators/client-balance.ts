import { z } from "zod";

import { toCents } from "@/lib/catalog/money";

// Valor em reais, maior que zero, até 2 casas e no máximo 99999999.99 (toCents confere formato e teto).
const positiveMoneySchema = z.string().refine((value) => {
	try {
		return toCents(value) > 0;
	} catch {
		return false;
	}
}, "Informe um valor maior que zero, com até 2 casas decimais.");

export const clientBalanceAdjustSchema = z.object({
	holderId: z.string().uuid("Titular inválido."),
	requestId: z.string().uuid("Pedido inválido."),
	direction: z.enum(["credit", "debit"], { message: "Escolha crédito ou débito." }),
	amount: positiveMoneySchema,
	reason: z.string().trim().min(5, "Informe o motivo, com pelo menos 5 caracteres.").max(500, "Motivo com no máximo 500 caracteres."),
});
