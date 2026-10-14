"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { registerCounterPayment, voidCounterPayment, type CounterFailure } from "@/lib/counter-payments/queries";
import { hasPermission } from "@/lib/db/permissions";
import { registerCounterPaymentSchema, voidCounterPaymentSchema } from "@/lib/validators/counter-payments";

export interface CounterPaymentActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para registrar pagamentos de balcão.";

const FAILURE_MESSAGES: Record<CounterFailure, string> = {
	not_found: "Dossiê não encontrado.",
	not_allowed: NOT_ALLOWED,
	reason_required: "Informe o motivo da anulação.",
	already_voided: "Este pagamento já foi anulado.",
};

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[counter-payments] ${step} falhou`, meta);
}

async function counterWriter(step: string) {
	try {
		const session = await getRequiredSession();
		return hasPermission(session, "counter:write") ? { session } : { error: NOT_ALLOWED };
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(step, error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
}

export async function registerCounterPaymentAction(values: unknown): Promise<CounterPaymentActionResult> {
	const parsed = registerCounterPaymentSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await counterWriter("registerCounterPaymentAction");
	if (!auth.session) return { error: auth.error };

	try {
		const result = await registerCounterPayment(auth.session, parsed.data);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] };
		revalidatePath("/settings/counter-payments");
		return { error: null, id: result.id };
	} catch (error) {
		logFailure("registerCounterPaymentAction", error);
		return { error: "Falha ao registrar o pagamento." };
	}
}

export async function voidCounterPaymentAction(values: unknown): Promise<CounterPaymentActionResult> {
	const parsed = voidCounterPaymentSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await counterWriter("voidCounterPaymentAction");
	if (!auth.session) return { error: auth.error };

	try {
		const result = await voidCounterPayment(auth.session, parsed.data);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] };
		revalidatePath("/settings/counter-payments");
		return { error: null, id: parsed.data.id };
	} catch (error) {
		logFailure("voidCounterPaymentAction", error);
		return { error: "Falha ao anular o pagamento." };
	}
}
