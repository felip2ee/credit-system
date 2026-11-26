"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import {
	acceptLegalDocuments,
	confirmPhoneVerification,
	requestPhoneVerification,
	setNotificationChannel,
	type AccountResult,
} from "@/lib/account/queries";
import { requestMeta } from "@/lib/account/request-meta";
import { generatePhoneCode } from "@/lib/account/secrets";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { toE164 } from "@/lib/notifications/recipient";
import {
	isPushSubscriptionActive,
	registerPushSubscription,
	removePushSubscription,
} from "@/lib/notifications/push-subscriptions";
import {
	legalAcceptSchema,
	notificationChannelSchema,
	phoneCodeSchema,
	phoneRequestSchema,
} from "@/lib/validators/account";
import { pushEndpointInputSchema, pushSubscriptionSchema } from "@/lib/validators/push";

export interface ActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Ação não permitida.";
const FAILED = "Não foi possível concluir. Tente novamente.";
const INVALID_PHONE = "Celular inválido. Use DDD e número.";
const NOT_BR_MOBILE = "Informe um celular brasileiro com DDD.";
const BR_MOBILE = /^\+55\d{2}9\d{8}$/;

type AccountReason =
	| "not_allowed"
	| "invalid_input"
	| "already_verified"
	| "cooldown"
	| "too_many"
	| "invalid"
	| "expired"
	| "too_many_attempts"
	| "phone_not_verified"
	| "outdated";

// already_verified muda com o canal (e-mail ou telefone): cada ação passa o texto dela.
const MESSAGES: Record<Exclude<AccountReason, "already_verified">, string> = {
	not_allowed: NOT_ALLOWED,
	invalid_input: NOT_ALLOWED,
	cooldown: "Aguarde 1 minuto antes de pedir outro envio.",
	too_many: "Limite de envios atingido. Tente de novo em uma hora.",
	invalid: "Código incorreto ou sem pedido ativo. Peça um novo código.",
	expired: "Código expirado. Peça um novo.",
	too_many_attempts: "Muitas tentativas. Peça um novo código.",
	phone_not_verified: "Confirme o telefone antes de escolher o WhatsApp.",
	outdated: "Os termos foram atualizados. Recarregue a página.",
};

function toActionResult(result: AccountResult<AccountReason>, alreadyVerified = FAILED): ActionResult {
	if (result.ok) return { error: null };
	return { error: result.reason === "already_verified" ? alreadyVerified : MESSAGES[result.reason] };
}

// Só nome e código do erro: nunca telefone, código, token nem a mensagem do driver.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[account] ${step} falhou`, meta);
}

// Só o próprio cliente mexe na conta. Operador, admin e superadmin em suporte nunca confirmam contato do cliente.
async function requireClient(): Promise<RequiredSession | null> {
	try {
		const session = await getRequiredSession();
		return session.role === "client" && hasPermission(session, "portal:write") ? session : null;
	} catch {
		return null;
	}
}

type Mutation = (session: RequiredSession) => Promise<ActionResult>;

async function runAsClient(step: string, work: Mutation): Promise<ActionResult> {
	const session = await requireClient();
	if (!session) return { error: NOT_ALLOWED };
	try {
		return await work(session);
	} catch (error) {
		logFailure(step, error);
		return { error: FAILED };
	}
}

export async function requestPhoneVerificationAction(values: unknown): Promise<ActionResult> {
	const parsed = phoneRequestSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };
	const phoneE164 = toE164(parsed.data.phone);
	if (!phoneE164) return { error: INVALID_PHONE };
	if (!BR_MOBILE.test(phoneE164)) return { error: NOT_BR_MOBILE };

	return runAsClient("requestPhoneVerificationAction", async (session) => {
		const result = toActionResult(
			await withUserTransaction(session, (client) =>
				requestPhoneVerification(client, session.userId, phoneE164, generatePhoneCode()),
			),
			"Este telefone já está confirmado.",
		);
		if (!result.error) revalidatePath("/portal/perfil");
		return result;
	});
}

export async function confirmPhoneAction(values: unknown): Promise<ActionResult> {
	const parsed = phoneCodeSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	return runAsClient("confirmPhoneAction", async (session) => {
		const result = toActionResult(
			await withUserTransaction(session, (client) => confirmPhoneVerification(client, session.userId, parsed.data.code)),
		);
		if (!result.error) revalidatePath("/portal/perfil");
		return result;
	});
}

export async function acceptLegalDocumentsAction(values: unknown): Promise<ActionResult> {
	const parsed = legalAcceptSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	return runAsClient("acceptLegalDocumentsAction", async (session) => {
		const meta = requestMeta(await headers());
		const result = toActionResult(
			await withUserTransaction(session, (client) => acceptLegalDocuments(client, session.userId, { ...parsed.data, ...meta })),
		);
		if (!result.error) revalidatePath("/portal", "layout");
		return result;
	});
}

export async function setNotificationChannelAction(values: unknown): Promise<ActionResult> {
	const parsed = notificationChannelSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	return runAsClient("setNotificationChannelAction", async (session) => {
		const result = toActionResult(
			await withUserTransaction(session, (client) => setNotificationChannel(client, session.userId, parsed.data.channel)),
		);
		if (!result.error) revalidatePath("/portal/perfil");
		return result;
	});
}

const PUSH_PAGE = "/portal/notificacoes";

export async function registerPushSubscriptionAction(values: unknown): Promise<ActionResult> {
	const parsed = pushSubscriptionSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };
	const { endpoint, keys } = parsed.data;

	return runAsClient("registerPushSubscriptionAction", async (session) => {
		const { userAgent } = requestMeta(await headers());
		const result = toActionResult(
			await withUserTransaction(session, (client) =>
				registerPushSubscription(client, { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent }),
			),
		);
		if (!result.error) revalidatePath(PUSH_PAGE);
		return result;
	});
}

export async function removePushSubscriptionAction(values: unknown): Promise<ActionResult> {
	const parsed = pushEndpointInputSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	return runAsClient("removePushSubscriptionAction", async (session) => {
		const result = toActionResult(
			await withUserTransaction(session, (client) => removePushSubscription(client, parsed.data.endpoint)),
		);
		if (!result.error) revalidatePath(PUSH_PAGE);
		return result;
	});
}

// A tela só mostra "ligado" se o servidor confirma o endpoint do navegador. Endpoint inválido não é erro: não há o que consultar.
export async function getPushSubscriptionStatusAction(values: unknown): Promise<{ error: string | null; subscribed: boolean }> {
	const parsed = pushEndpointInputSchema.safeParse(values);
	if (!parsed.success) return { error: null, subscribed: false };

	const session = await requireClient();
	if (!session) return { error: NOT_ALLOWED, subscribed: false };
	try {
		const subscribed = await withUserTransaction(session, (client) => isPushSubscriptionActive(client, parsed.data.endpoint));
		return { error: null, subscribed };
	} catch (error) {
		logFailure("getPushSubscriptionStatusAction", error);
		return { error: FAILED, subscribed: false };
	}
}
