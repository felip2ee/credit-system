"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import {
	cancelPayout,
	createPayout,
	markPayoutPaid,
	type PayoutFailure,
} from "@/lib/payouts/queries";
import {
	discardPayoutReceipt,
	ReceiptRejectedError,
	ScannerUnavailableError,
	storePayoutReceipt,
	type ReceiptRejection,
} from "@/lib/payouts/receipt";
import { createPayoutSchema, payoutIdSchema } from "@/lib/validators/payouts";

export interface PayoutActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar repasses.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para gerenciar repasses.";
const RECEIPT_REQUIRED = "Anexe o comprovante do repasse.";
const GENERIC_FAILURE = "Não foi possível concluir a operação.";

const FAILURE_MESSAGES: Record<PayoutFailure, string> = {
	not_allowed: NOT_ALLOWED,
	invalid_cutoff: "Data de corte inválida.",
	not_found: "Repasse ou Bureau não encontrado.",
	nothing_to_pay: "Não há valor a repassar até a data de corte.",
	invalid_state: "O repasse não está em um estado que permita esta operação.",
	already_paid: "Este repasse já foi pago com outro comprovante.",
	invalid_receipt: "Comprovante inválido.",
};

const REJECTION_MESSAGES: Record<ReceiptRejection, string> = {
	too_large: "O comprovante deve ter no máximo 5 MB.",
	invalid_type: "Envie o comprovante em PDF, PNG ou JPEG.",
	infected: "O arquivo foi recusado pela verificação de segurança.",
};

// Só nome e código do erro: nunca nome nem conteúdo do arquivo.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[payouts] ${step} falhou`, meta);
}

// Falha limpa = o banco recusou com um SQLSTATE (a transação voltou). Sem SQLSTATE, ou com classe 08 (conexão) ou 57
// (servidor), o COMMIT pode ter chegado ao banco: o repasse pode estar pago com este comprovante.
const AMBIGUOUS_SQLSTATE_CLASSES = ["08", "57"];
function isCleanRollback(error: unknown): boolean {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	return (
		typeof code === "string" &&
		/^[0-9A-Z]{5}$/.test(code) &&
		!AMBIGUOUS_SQLSTATE_CLASSES.some((prefix) => code.startsWith(prefix))
	);
}

// Repasse é só do superadmin fora de suporte (a auditoria e as funções SQL são de plataforma).
async function payoutManager(step: string): Promise<{ session: RequiredSession } | { error: string }> {
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(step, error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (session.role !== "superadmin" || !hasPermission(session, "payout:manage")) return { error: NOT_ALLOWED };
	if (session.supportSessionId || session.support) return { error: SUPPORT_ACTIVE };
	return { session };
}

const revalidate = () => {
	revalidatePath("/superadmin/payouts");
	revalidatePath("/settings/payouts");
};

export async function createPayoutAction(values: unknown): Promise<PayoutActionResult> {
	const parsed = createPayoutSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await payoutManager("createPayoutAction");
	if ("error" in auth) return { error: auth.error };

	try {
		const result = await createPayout(auth.session, parsed.data);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] ?? GENERIC_FAILURE };
		revalidate();
		return { error: null, id: result.payoutId };
	} catch (error) {
		logFailure("createPayoutAction", error);
		return { error: "Falha ao criar o repasse." };
	}
}

// Recebe FormData: payoutId e receipt (arquivo). Autoriza antes de tocar no arquivo.
export async function markPayoutPaidAction(formData: FormData): Promise<PayoutActionResult> {
	const parsed = payoutIdSchema.safeParse({ payoutId: formData.get("payoutId") });
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await payoutManager("markPayoutPaidAction");
	if ("error" in auth) return { error: auth.error };

	const file = formData.get("receipt");
	if (!(file instanceof File) || file.size === 0) return { error: RECEIPT_REQUIRED };

	let stored;
	try {
		stored = await storePayoutReceipt(file);
	} catch (error) {
		if (error instanceof ReceiptRejectedError) return { error: REJECTION_MESSAGES[error.reason] };
		logFailure("markPayoutPaidAction.store", error);
		if (error instanceof ScannerUnavailableError) {
			return { error: "Não foi possível verificar o arquivo agora. Tente novamente." };
		}
		return { error: "Falha ao guardar o comprovante." };
	}

	// O objeto só fica se o banco registrar este comprovante: qualquer outra saída o remove, menos o commit ambíguo.
	let keep = false;
	try {
		const result = await markPayoutPaid(auth.session, { payoutId: parsed.data.payoutId, receipt: stored });
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] ?? GENERIC_FAILURE };
		keep = !result.replayed;
		revalidate();
		return { error: null, id: parsed.data.payoutId };
	} catch (error) {
		logFailure("markPayoutPaidAction.persist", error);
		if (!isCleanRollback(error)) {
			// Apagar agora poderia deixar um repasse pago sem comprovante. Conciliar: o repasse aponta para esta chave?
			keep = true;
			console.error("[payouts] comprovante mantido: commit ambíguo, conciliar à mão", {
				payoutId: parsed.data.payoutId,
				objectKey: stored.objectKey,
			});
		}
		return { error: "Falha ao registrar o pagamento do repasse." };
	} finally {
		if (!keep) await discardPayoutReceipt(stored.objectKey).catch((e) => logFailure("markPayoutPaidAction.discard", e));
	}
}

export async function cancelPayoutAction(values: unknown): Promise<PayoutActionResult> {
	const parsed = payoutIdSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await payoutManager("cancelPayoutAction");
	if ("error" in auth) return { error: auth.error };

	try {
		const result = await cancelPayout(auth.session, parsed.data.payoutId);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] ?? GENERIC_FAILURE };
		revalidate();
		return { error: null, id: parsed.data.payoutId };
	} catch (error) {
		logFailure("cancelPayoutAction", error);
		return { error: "Falha ao cancelar o repasse." };
	}
}
