import { fromCents, toCents } from "@/lib/catalog/money";
import type { CommissionStatus } from "@/lib/affiliates/types";

export type WithdrawalFee = { fixed: string; percent: string };
export type WithdrawalPreview = { fee: string; net: string; valid: boolean };

const INVALID_PREVIEW: WithdrawalPreview = { fee: "0.00", net: "0.00", valid: false };

// Mesma conta da função SQL: round(fixo + percentual * valor / 100, 2). Em centavos inteiros.
export function withdrawalPreview(amount: string, fee: WithdrawalFee): WithdrawalPreview {
	try {
		const amountCents = toCents(amount);
		const feeCents = toCents(fee.fixed) + Math.round((amountCents * toCents(fee.percent)) / 10_000);
		const netCents = amountCents - feeCents;
		return { fee: fromCents(feeCents), net: fromCents(Math.max(netCents, 0)), valid: amountCents > 0 && netCents > 0 };
	} catch {
		return INVALID_PREVIEW;
	}
}

const dayMonth = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

export function commissionStatusLabel(status: CommissionStatus, releaseAt: string): string {
	if (status === "pending") return `Em carência até ${dayMonth.format(new Date(releaseAt))}`;
	return status === "released" ? "Disponível" : "Revertida";
}
