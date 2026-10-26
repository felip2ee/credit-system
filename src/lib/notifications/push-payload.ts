import { BRAND_NAME } from "@/lib/brand/brand";

import { TemplateRenderError } from "./errors";

// Texto fixo no código: o banco guarda só a url. Nada de CPF, CNPJ, valor ou nome na tela bloqueada.
const PUSH_BODIES = {
	scr_partner_authorized: "Um sócio autorizou sua consulta",
	research_released: "Sua consulta está pronta",
	commission_received: "Você recebeu uma comissão",
	commission_available: "Você tem comissão disponível para saque",
} as const;

export type PushTemplateKey = keyof typeof PUSH_BODIES;

export interface PushPayload {
	title: string;
	body: string;
	url: string;
}

function isPushTemplateKey(key: string): key is PushTemplateKey {
	return Object.hasOwn(PUSH_BODIES, key);
}

export function buildPushPayload(templateKey: string, params: Record<string, string>): PushPayload {
	if (!isPushTemplateKey(templateKey)) throw new TemplateRenderError("unknown push template");
	const url = params.url;
	// Caminho do próprio site: o service worker abre a url ao toque, então host externo não passa.
	if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("\\")) {
		throw new TemplateRenderError("push url must be a relative path");
	}
	return { title: BRAND_NAME, body: PUSH_BODIES[templateKey], url };
}
