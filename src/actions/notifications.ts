"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { platformIdentity, withUserTransaction } from "@/lib/db/transaction";
import {
	enqueueNotification,
	retryNotification,
	type EnqueueFailure,
	type RetryFailure,
} from "@/lib/notifications/queries";
import { retryNotificationSchema, sendTestNotificationSchema } from "@/lib/validators/notifications";

export interface NotificationActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar notificações.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para gerenciar notificações.";
const LIST_PATH = "/superadmin/notifications";

const RETRY_MESSAGES: Record<RetryFailure, string> = {
	not_allowed: NOT_ALLOWED,
	not_found: "Notificação não encontrada.",
	invalid_state: "Só uma notificação com falha pode ser reenviada.",
	payload_purged: "Dados do envio já apagados.",
};

const ENQUEUE_MESSAGES: Record<EnqueueFailure, string> = {
	not_allowed: NOT_ALLOWED,
	invalid_recipient: "Destinatário inválido para o canal escolhido.",
	invalid_params: "Parâmetros inválidos para o template.",
	template_not_found: "Template de teste não encontrado para o canal.",
};

// Só nome e código do erro: sem destinatário nem parâmetros.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[notifications] ${step} falhou`, meta);
}

type Authorized = { session: RequiredSession } | { error: string };

// notifications:manage vale para o superadmin; em suporte ele herda a permissão, mas as ações de plataforma exigem estar fora dele.
async function authorize(step: string): Promise<Authorized> {
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(`${step}.session`, error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (session.role !== "superadmin" || !hasPermission(session, "notifications:manage")) return { error: NOT_ALLOWED };
	if (session.supportSessionId || session.support) return { error: SUPPORT_ACTIVE };
	return { session };
}

export async function retryNotificationAction(values: unknown): Promise<NotificationActionResult> {
	const parsed = retryNotificationSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await authorize("retryNotificationAction");
	if ("error" in auth) return { error: auth.error };

	try {
		const retry = await retryNotification(auth.session, parsed.data.id);
		if (!retry.ok) return { error: RETRY_MESSAGES[retry.reason] ?? "Não foi possível concluir a operação." };
		revalidatePath(LIST_PATH);
		return { error: null, id: parsed.data.id };
	} catch (error) {
		logFailure("retryNotificationAction", error);
		return { error: "Falha ao pedir a nova tentativa da notificação." };
	}
}

// Teste de plataforma: sem Bureau, template platform_test, uma linha nova a cada chamada.
export async function sendTestNotificationAction(values: unknown): Promise<NotificationActionResult> {
	const parsed = sendTestNotificationSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await authorize("sendTestNotificationAction");
	if ("error" in auth) return { error: auth.error };

	const identity = platformIdentity(auth.session);
	try {
		const result = await withUserTransaction(identity, (client) =>
			enqueueNotification(client, identity, {
				templateKey: "platform_test",
				channel: parsed.data.channel,
				recipient: parsed.data.recipient,
				params: {},
				idempotencyKey: `test:${randomUUID()}`,
			}),
		);
		if (!result.ok) return { error: ENQUEUE_MESSAGES[result.reason] ?? "Não foi possível concluir a operação." };
		revalidatePath(LIST_PATH);
		return { error: null, id: result.id };
	} catch (error) {
		logFailure("sendTestNotificationAction", error);
		return { error: "Falha ao enfileirar o envio de teste." };
	}
}
