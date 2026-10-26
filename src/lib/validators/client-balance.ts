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

// Sem documento no motivo: 11 dígitos seguidos, CPF ou CNPJ formatado (o motivo vai ao extrato do cliente e à auditoria).
const DOCUMENT_IN_REASON = /\d{11,}|\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
export const DOCUMENT_IN_REASON_MESSAGE = "Não escreva CPF ou CNPJ no motivo.";

export const clientBalanceAdjustSchema = z.object({
	holderId: z.string().uuid("Titular inválido."),
	requestId: z.string().uuid("Pedido inválido."),
	direction: z.enum(["credit", "debit"], { message: "Escolha crédito ou débito." }),
	amount: positiveMoneySchema,
	reason: z.string().trim().min(5, "Informe o motivo, com pelo menos 5 caracteres.").max(500, "Motivo com no máximo 500 caracteres.")
		.refine((value) => !DOCUMENT_IN_REASON.test(value), DOCUMENT_IN_REASON_MESSAGE),
});
