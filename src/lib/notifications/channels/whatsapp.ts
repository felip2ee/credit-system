import { randomUUID } from "node:crypto";

import { readWhatsappConfig } from "@/lib/config";

import { classifyGraphError, TemplateRenderError } from "../errors";
import { maskRecipient } from "../recipient";
import { buildWhatsappPayload, validateWhatsappParams } from "../render";
import type { ClaimedNotification, SendResult } from "../types";

const GRAPH_TIMEOUT_MS = 10_000;

// Nada aqui loga nem devolve mensagem de erro de rede ou da Meta: o token de acesso vai no cabeçalho.
export async function sendWhatsappNotification(notification: ClaimedNotification): Promise<SendResult> {
	let config;
	try {
		config = readWhatsappConfig(process.env);
	} catch {
		return { ok: false, permanent: false, code: "config_error" };
	}
	if (!config) return { ok: false, permanent: true, code: "channel_not_configured" };

	if (!validateWhatsappParams(notification.params).ok) {
		return { ok: false, permanent: true, code: "invalid_params" };
	}
	let payload;
	try {
		payload = buildWhatsappPayload(notification, notification.params, notification.recipient);
	} catch (error) {
		if (error instanceof TemplateRenderError) return { ok: false, permanent: error.permanent, code: error.code };
		throw error;
	}

	if (config.driver === "fake") {
		// O driver fake é recusado em produção; o log existe para o desenvolvedor ler o código de verificação.
		if (process.env.NODE_ENV !== "production") {
			// eslint-disable-next-line no-console
			console.info("[whatsapp:fake]", {
				template: notification.template_key,
				to: maskRecipient("whatsapp", notification.recipient),
				params: notification.params,
			});
		}
		return { ok: true, providerMessageId: `fake-wamid-${randomUUID()}` };
	}

	const endpoint = `${config.graphBaseUrl.replace(/\/+$/, "")}/${config.graphVersion}/${config.phoneNumberId}/messages`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
		});
	} catch (error) {
		return { ok: false, ...classifyGraphError(null, null, error) };
	}

	let body: unknown = null;
	let bodyError: unknown = null;
	try {
		body = await response.json();
	} catch (error) {
		bodyError = error;
	}
	if (!response.ok) return { ok: false, ...classifyGraphError(response.status, body, null) };

	// 2xx: a Meta aceitou o pedido. Sem id legível não dá para saber se a mensagem saiu (inclui timeout na leitura
	// do corpo); tentar de novo pode duplicar a mensagem, então não repete. O código vai para o log do worker.
	const messages = (body as { messages?: Array<{ id?: unknown }> } | null)?.messages;
	const id = messages?.[0]?.id;
	if (bodyError || typeof id !== "string" || !id) return { ok: false, permanent: true, code: "ambiguous_success" };
	return { ok: true, providerMessageId: id };
}
