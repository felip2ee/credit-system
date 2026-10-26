"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { formatCurrency } from "@/lib/utils";
import { clientBalanceAdjustSchema, DOCUMENT_IN_REASON_MESSAGE } from "@/lib/validators/client-balance";
import { adjustClientBalance, type ClientAdjustmentFailure } from "@/lib/wallet/client-adjustment";

export interface ClientBalanceResult {
	error: string | null;
}

const NOT_ALLOWED = "Você não tem permissão para ajustar o saldo de clientes.";
const SESSION_CHECK_FAILED = "Não foi possível verificar sua sessão. Tente novamente.";
const FAILED = "Não foi possível ajustar o saldo. Tente novamente.";

const REASON_MESSAGE: Record<ClientAdjustmentFailure, string> = {
	not_allowed: NOT_ALLOWED,
	invalid_direction: "Escolha crédito ou débito.",
	invalid_amount: "Informe um valor maior que zero, com até 2 casas decimais.",
	invalid_reason: `Informe o motivo, de 5 a 500 caracteres. ${DOCUMENT_IN_REASON_MESSAGE}`,
	invalid_request: "Pedido inválido. Feche e abra o diálogo de novo.",
	request_conflict: "Este pedido já foi usado com outros dados. Feche e abra o diálogo de novo.",
	not_found: "Cliente não encontrado.",
	insufficient_bureau_funds: "Saldo do Bureau insuficiente para este crédito.",
	insufficient_client_funds: "Saldo disponível do cliente insuficiente para este débito.",
	exceeds_bureau_credit: "O Bureau só pode remover o que ele mesmo creditou a este cliente.",
};

function failureMessage(result: { reason: ClientAdjustmentFailure; maxDebit?: string }): string {
	if (result.reason === "exceeds_bureau_credit" && result.maxDebit !== undefined) {
		return `O Bureau só pode remover o que ele mesmo creditou a este cliente (máximo ${formatCurrency(Number(result.maxDebit))}).`;
	}
	return REASON_MESSAGE[result.reason] ?? FAILED;
}

// Só nome e código do erro: sem valores, motivo nem dados pessoais.
function logFailure(error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error("[credits] adjustClientBalanceAction falhou", meta);
}

// Ajuste do Bureau no saldo do cliente: a sessão decide o Bureau; o banco confere papel, cliente e saldos.
export async function adjustClientBalanceAction(values: unknown): Promise<ClientBalanceResult> {
	const parsed = clientBalanceAdjustSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let session: Awaited<ReturnType<typeof getRequiredSession>>;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(error);
		return { error: SESSION_CHECK_FAILED };
	}
	if (!hasPermission(session, "credits:adjust")) return { error: NOT_ALLOWED };

	try {
		const result = await adjustClientBalance(session, parsed.data);
		if (!result.ok) return { error: failureMessage(result) };
	} catch (error) {
		logFailure(error);
		return { error: FAILED };
	}
	revalidatePath(`/holders/${parsed.data.holderId}`);
	revalidatePath("/settings/wallet");
	revalidatePath("/portal/credits");
	return { error: null };
}
