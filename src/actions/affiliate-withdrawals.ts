"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isAffiliateEnabled } from "@/lib/affiliates/enabled";
import {
	cancelWithdrawal,
	convertCommission,
	markWithdrawalPaid,
	requestWithdrawal,
	type WithdrawalFailure,
} from "@/lib/affiliates/withdrawals";
import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { toCents } from "@/lib/catalog/money";
import { readAffiliateWithdrawalsEnabled } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { toE164 } from "@/lib/notifications/recipient";
import {
	discardPayoutReceipt,
	ReceiptRejectedError,
	ScannerUnavailableError,
	storePayoutReceipt,
	type ReceiptRejection,
} from "@/lib/payouts/receipt";
import { isValidCNPJ, isValidCPF, isValidEmail, onlyDigits } from "@/lib/utils";
import { uuidSchema } from "@/lib/validators/id";

export interface AffiliateWithdrawalResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED_CLIENT = "Você não tem permissão para usar a comissão de afiliado.";
const NOT_ALLOWED_MANAGER = "Você não tem permissão para gerenciar saques.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para gerenciar saques.";
const SESSION_CHECK_FAILED = "Não foi possível verificar sua sessão. Tente novamente.";
const RECEIPT_REQUIRED = "Anexe o comprovante do pagamento.";
const WITHDRAWALS_DISABLED = "O saque ainda não está disponível.";
const AFFILIATE_DISABLED = "A afiliação não está disponível neste momento.";
const GENERIC_FAILURE = "Não foi possível concluir a operação.";
const MAX_REASON_LENGTH = 500;

const FAILURE_MESSAGES: Record<WithdrawalFailure, string> = {
	not_allowed: "Você não tem permissão para esta operação.",
	not_found: "Saque ou conta não encontrado.",
	invalid_amount: "Informe um valor maior que zero, com até 2 casas decimais.",
	invalid_pix_key: "Chave PIX inválida.",
	pix_key_not_owner: "A chave CPF/CNPJ precisa ser o documento da sua conta.",
	invalid_request: "Pedido inválido. Recarregue a página e tente de novo.",
	invalid_reason: "Informe o motivo do cancelamento (até 500 caracteres).",
	invalid_receipt: "Comprovante inválido.",
	invalid_state: "O saque não está em um estado que permita esta operação.",
	already_paid: "Este saque já foi pago com outro comprovante.",
	net_not_positive: "O valor é menor ou igual à taxa de saque. Peça um valor maior.",
	withdrawal_open: "Você já tem um saque em aberto. Espere o pagamento ou o cancelamento.",
	insufficient_funds: "Valor maior que o saldo disponível. O valor em carência ainda não pode ser usado.",
	idempotency_conflict: "Este pedido já foi feito com outro valor. Recarregue a página e tente de novo.",
};

const REJECTION_MESSAGES: Record<ReceiptRejection, string> = {
	too_large: "O comprovante deve ter no máximo 5 MB.",
	invalid_type: "Envie o comprovante em PDF, PNG ou JPEG.",
	infected: "O arquivo foi recusado pela verificação de segurança.",
};

const failureMessage = (reason: WithdrawalFailure | undefined): string =>
	(reason && FAILURE_MESSAGES[reason]) || GENERIC_FAILURE;

// Só nome e código do erro: nunca valor, chave PIX nem nome do arquivo.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[affiliate-withdrawals] ${step} falhou`, meta);
}

// Falha limpa = o banco recusou com um SQLSTATE (a transação voltou). Sem SQLSTATE, ou com classe 08 (conexão) ou 57
// (servidor), o COMMIT pode ter chegado ao banco: o saque pode estar pago com este comprovante.
const AMBIGUOUS_SQLSTATE_CLASSES = ["08", "57"];
function isCleanRollback(error: unknown): boolean {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	return (
		typeof code === "string" &&
		/^[0-9A-Z]{5}$/.test(code) &&
		!AMBIGUOUS_SQLSTATE_CLASSES.some((prefix) => code.startsWith(prefix))
	);
}

const moneySchema = z.string().refine((value) => {
	try {
		return toCents(value) > 0;
	} catch {
		return false;
	}
}, FAILURE_MESSAGES.invalid_amount);

const PIX_KEY_MESSAGES = {
	document: "Informe um CPF ou CNPJ válido.",
	email: "Informe um e-mail válido.",
	phone: "Informe o celular com DDD (ex.: +5563912345678).",
	random: "Informe a chave aleatória (formato UUID).",
} as const;

// Devolve a chave no formato que o pagamento usa (documento só com dígitos, telefone em E.164, UUID em minúsculas).
function normalizePixKey(type: keyof typeof PIX_KEY_MESSAGES, key: string): string | null {
	switch (type) {
		case "document": {
			const digits = onlyDigits(key);
			return isValidCPF(digits) || isValidCNPJ(digits) ? digits : null;
		}
		case "email":
			return isValidEmail(key) && key.length <= 200 ? key : null;
		case "phone":
			return toE164(key);
		case "random": {
			const parsed = uuidSchema.safeParse(key);
			return parsed.success ? parsed.data.toLowerCase() : null;
		}
	}
}

const requestSchema = z
	.object({
		amount: moneySchema,
		pixKeyType: z.enum(["document", "email", "phone", "random"], { errorMap: () => ({ message: "Escolha o tipo da chave PIX." }) }),
		pixKey: z.string().trim().max(200, "Chave PIX muito longa."),
		ownKeyDeclaration: z.literal(true, { errorMap: () => ({ message: "Declare que a chave PIX está no seu nome." }) }),
	})
	.transform((value, ctx) => {
		const pixKey = normalizePixKey(value.pixKeyType, value.pixKey);
		if (!pixKey) {
			ctx.addIssue({ code: "custom", path: ["pixKey"], message: PIX_KEY_MESSAGES[value.pixKeyType] });
			return z.NEVER;
		}
		return { amount: value.amount, pixKeyType: value.pixKeyType, pixKey };
	});

const convertSchema = z.object({ amount: moneySchema, requestId: uuidSchema.optional() });
const cancelSchema = z.object({
	id: uuidSchema,
	reason: z.string().trim().min(1, FAILURE_MESSAGES.invalid_reason).max(MAX_REASON_LENGTH, FAILURE_MESSAGES.invalid_reason),
});
const markPaidSchema = z.object({ withdrawalId: uuidSchema });

async function currentSession(step: string): Promise<{ session: RequiredSession } | { error: string }> {
	try {
		return { session: await getRequiredSession() };
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED_CLIENT };
		logFailure(step, error);
		return { error: SESSION_CHECK_FAILED };
	}
}

// Saque e conversão são do cliente dono da comissão (a conta vem da sessão, nunca do formulário).
async function affiliateClient(step: string): Promise<{ session: RequiredSession } | { error: string }> {
	const current = await currentSession(step);
	if ("error" in current) return current;
	const { session } = current;
	if (session.role !== "client" || !hasPermission(session, "affiliates:read")) return { error: NOT_ALLOWED_CLIENT };
	// Seção desligada pelo Bureau: a ação recusa, não só a tela.
	try {
		if (!(await isAffiliateEnabled(session))) return { error: AFFILIATE_DISABLED };
	} catch (error) {
		logFailure(step, error);
		return { error: SESSION_CHECK_FAILED };
	}
	return { session };
}

// Pagar e cancelar são só do superadmin fora de suporte (a auditoria e as funções SQL são de plataforma).
async function withdrawalManager(step: string): Promise<{ session: RequiredSession } | { error: string }> {
	const current = await currentSession(step);
	if ("error" in current) return current.error === NOT_ALLOWED_CLIENT ? { error: NOT_ALLOWED_MANAGER } : current;
	const { session } = current;
	if (session.role !== "superadmin" || !hasPermission(session, "withdrawals:manage")) return { error: NOT_ALLOWED_MANAGER };
	if (session.supportSessionId || session.support) return { error: SUPPORT_ACTIVE };
	return { session };
}

const revalidateClient = () => {
	revalidatePath("/portal");
	revalidatePath("/portal/afiliacao");
	revalidatePath("/portal/afiliacao/saque");
};
const revalidateManager = () => {
	revalidatePath("/superadmin/saques");
	revalidatePath("/superadmin/saques/[id]", "page");
};

export async function requestWithdrawalAction(values: unknown): Promise<AffiliateWithdrawalResult> {
	// Desligado até a validação fiscal: não lê sessão nem banco.
	if (!readAffiliateWithdrawalsEnabled(process.env)) return { error: WITHDRAWALS_DISABLED };

	const parsed = requestSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await affiliateClient("requestWithdrawalAction");
	if ("error" in auth) return { error: auth.error };

	try {
		const result = await requestWithdrawal(auth.session, parsed.data);
		if (!result.ok) return { error: failureMessage(result.reason) };
		revalidateClient();
		revalidateManager();
		return { error: null, id: result.withdrawalId };
	} catch (error) {
		logFailure("requestWithdrawalAction", error);
		return { error: "Falha ao solicitar o saque." };
	}
}

// O formulário pode mandar requestId para que um clique duplo converta uma vez; sem ele o servidor gera um.
export async function convertCommissionAction(values: unknown): Promise<AffiliateWithdrawalResult> {
	const parsed = convertSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await affiliateClient("convertCommissionAction");
	if ("error" in auth) return { error: auth.error };

	try {
		const result = await convertCommission(auth.session, {
			amount: parsed.data.amount,
			requestId: parsed.data.requestId ?? randomUUID(),
		});
		if (!result.ok) return { error: failureMessage(result.reason) };
		revalidateClient();
		return { error: null };
	} catch (error) {
		logFailure("convertCommissionAction", error);
		return { error: "Falha ao converter a comissão em créditos." };
	}
}

// Recebe FormData: withdrawalId e receipt (arquivo). Autoriza antes de tocar no arquivo.
export async function markWithdrawalPaidAction(formData: FormData): Promise<AffiliateWithdrawalResult> {
	const parsed = markPaidSchema.safeParse({ withdrawalId: formData.get("withdrawalId") });
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await withdrawalManager("markWithdrawalPaidAction");
	if ("error" in auth) return { error: auth.error };

	const file = formData.get("receipt");
	if (!(file instanceof File) || file.size === 0) return { error: RECEIPT_REQUIRED };

	let stored;
	try {
		stored = await storePayoutReceipt(file);
	} catch (error) {
		if (error instanceof ReceiptRejectedError) return { error: REJECTION_MESSAGES[error.reason] };
		logFailure("markWithdrawalPaidAction.store", error);
		if (error instanceof ScannerUnavailableError) {
			return { error: "Não foi possível verificar o arquivo agora. Tente novamente." };
		}
		return { error: "Falha ao guardar o comprovante." };
	}

	// O objeto só fica se o banco registrar este comprovante: qualquer outra saída o remove, menos o commit ambíguo.
	let keep = false;
	try {
		const result = await markWithdrawalPaid(auth.session, { id: parsed.data.withdrawalId, receipt: stored });
		if (!result.ok) return { error: failureMessage(result.reason) };
		keep = !result.replayed;
		revalidateManager();
		revalidateClient();
		return { error: null, id: parsed.data.withdrawalId };
	} catch (error) {
		logFailure("markWithdrawalPaidAction.persist", error);
		if (!isCleanRollback(error)) {
			// Apagar agora poderia deixar um saque pago sem comprovante. Conciliar: o saque aponta para esta chave?
			keep = true;
			console.error("[affiliate-withdrawals] comprovante mantido: commit ambíguo, conciliar à mão", {
				withdrawalId: parsed.data.withdrawalId,
				objectKey: stored.objectKey,
			});
		}
		return { error: "Falha ao registrar o pagamento do saque." };
	} finally {
		if (!keep) {
			await discardPayoutReceipt(stored.objectKey).catch((e) => logFailure("markWithdrawalPaidAction.discard", e));
		}
	}
}

export async function cancelWithdrawalAction(values: unknown): Promise<AffiliateWithdrawalResult> {
	const parsed = cancelSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await withdrawalManager("cancelWithdrawalAction");
	if ("error" in auth) return { error: auth.error };

	try {
		const result = await cancelWithdrawal(auth.session, parsed.data);
		if (!result.ok) return { error: failureMessage(result.reason) };
		revalidateManager();
		revalidateClient();
		return { error: null, id: parsed.data.id };
	} catch (error) {
		logFailure("cancelWithdrawalAction", error);
		return { error: "Falha ao cancelar o saque." };
	}
}
