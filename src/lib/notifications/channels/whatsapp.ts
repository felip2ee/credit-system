import { randomUUID } from "node:crypto";

import { readWhatsappConfig } from "@/lib/config";

import { classifyGraphError, TemplateRenderError } from "../errors";
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

	if (config.driver === "fake") return { ok: true, providerMessageId: `fake-wamid-${randomUUID()}` };

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

	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) return { ok: false, ...classifyGraphError(response.status, body, null) };

	const messages = (body as { messages?: Array<{ id?: unknown }> } | null)?.messages;
	const id = messages?.[0]?.id;
	if (typeof id !== "string" || !id) return { ok: false, permanent: false, code: "invalid_response" };
	return { ok: true, providerMessageId: id };
}
