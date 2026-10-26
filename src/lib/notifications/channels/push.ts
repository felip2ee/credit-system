import { sendNotification, type RequestOptions } from "web-push";

import { readPushConfig } from "@/lib/config";
import { getDispatchPool } from "@/lib/db/dispatch-pool";

import { classifyPushError, TemplateRenderError } from "../errors";
import { isAllowedPushEndpoint } from "../push-endpoint";
import { buildPushPayload } from "../push-payload";
import type { ClaimedNotification, SendResult } from "../types";

const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

interface PushSubscriptionKeys {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushDeps {
	send: (subscription: PushSubscriptionKeys, payload: string, options: object) => Promise<unknown>;
	query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
}

// Adapter do web-push. Ele usa https.request: não segue redirecionamento, então um 3xx vira WebPushError (provider_rejected).
const defaultDeps: PushDeps = {
	send: (subscription, payload, options) => sendNotification(subscription, payload, options as RequestOptions),
	query: (sql, values) => getDispatchPool().query(sql, values),
};

// Nada aqui loga nem devolve endpoint, chaves ou mensagem do serviço de push: o endpoint identifica o aparelho.
export async function sendPushNotification(
	notification: ClaimedNotification,
	deps: Partial<PushDeps> = {},
): Promise<SendResult> {
	const { send, query } = { ...defaultDeps, ...deps };

	let pushConfig;
	try {
		pushConfig = readPushConfig(process.env);
	} catch {
		return { ok: false, permanent: false, code: "config_error" };
	}
	if (!pushConfig) return { ok: false, permanent: true, code: "channel_not_configured" };

	let payload;
	try {
		payload = buildPushPayload(notification.template_key, notification.params);
	} catch (error) {
		if (error instanceof TemplateRenderError) return { ok: false, permanent: error.permanent, code: error.code };
		throw error;
	}

	const { rows } = await query("select endpoint, p256dh, auth from push_subscription_for_delivery($1, $2)", [
		notification.id,
		notification.lease_id,
	]);
	const subscription = rows[0] as { endpoint: string; p256dh: string; auth: string } | undefined;
	if (!subscription) return { ok: false, permanent: true, code: "subscription_gone" };

	// A lista de hosts vale também aqui: o endpoint vem do cliente e esta chamada faz POST nele (SSRF).
	if (!isAllowedPushEndpoint(subscription.endpoint)) return { ok: false, permanent: true, code: "invalid_endpoint" };

	try {
		await send(
			{ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
			JSON.stringify(payload),
			{
				vapidDetails: { subject: pushConfig.subject, publicKey: pushConfig.publicKey, privateKey: pushConfig.privateKey },
				TTL: PUSH_TTL_SECONDS,
				urgency: "normal",
				timeout: PUSH_TIMEOUT_MS,
			},
		);
		return { ok: true, providerMessageId: `push:${notification.id}` };
	} catch (error) {
		const classified = classifyPushError(error);
		if (classified.code === "push_gone") {
			await query("select delete_gone_push_subscription($1, $2)", [notification.id, notification.lease_id]);
		}
		return { ok: false, ...classified };
	}
}
