import { z } from "zod";

import { toCents } from "@/lib/catalog/money";

// Valor em reais com sinal, diferente de zero, até 2 casas e |valor| <= 99999999.99.
export const signedMoneySchema = z.string().refine((value) => {
	try {
		return toCents(value.startsWith("-") ? value.slice(1) : value) > 0;
	} catch {
		return false;
	}
}, "Informe um valor diferente de zero, com até 2 casas decimais (use - para débito).");

export const walletAdjustSchema = z.object({
	bureauId: z.string().uuid(),
	amount: signedMoneySchema,
	reason: z.string().trim().min(1, "Informe o motivo do ajuste.").max(500, "Motivo com no máximo 500 caracteres."),
	idempotencyKey: z.string().uuid(),
});

export type WalletAdjustInput = z.infer<typeof walletAdjustSchema>;

// Recarga PIX: R$ 10,00 a R$ 5.000,00 por cobrança, em reais com até 2 casas (contas em centavos inteiros).
const MIN_TOPUP_CENTS = 1000;
const MAX_TOPUP_CENTS = 500000;

export const topupAmountSchema = z.string().refine((value) => {
	try {
		const cents = toCents(value);
		return cents >= MIN_TOPUP_CENTS && cents <= MAX_TOPUP_CENTS;
	} catch {
		return false;
	}
}, "Informe um valor entre R$ 10,00 e R$ 5.000,00, com até 2 casas decimais.");

export const walletTopupSchema = z.object({ amount: topupAmountSchema });
