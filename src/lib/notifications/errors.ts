// Classifica falha de provedor em permanente (não adianta tentar de novo) ou transitória.
// Códigos da Graph API conferidos em
// developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes (14/10/2026):
// 130429/131056 limite de taxa; 131026 sem WhatsApp; 132000/132001/132005/132007/132012 parâmetro ou
// template inválido, 132015 pausado, 132016 desativado; 190 token inválido ou expirado.

export interface ErrorClassification {
	permanent: boolean;
	code: string;
}

export class TemplateRenderError extends Error {
	readonly permanent = true;
	readonly code = "template_render_error";

	constructor(message: string) {
		super(message);
		this.name = "TemplateRenderError";
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

const SMTP_TRANSIENT_CODES: Record<string, string> = {
	ETIMEDOUT: "smtp_timeout",
	ECONNECTION: "smtp_connection",
	ESOCKET: "smtp_connection",
};

export function classifySmtpError(error: unknown): ErrorClassification {
	const info = asRecord(error);
	const responseCode = typeof info?.responseCode === "number" ? info.responseCode : null;
	if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
		return { permanent: true, code: "smtp_rejected" };
	}
	if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
		return { permanent: false, code: "smtp_deferred" };
	}
	const code = typeof info?.code === "string" ? info.code : "";
	return { permanent: false, code: SMTP_TRANSIENT_CODES[code] ?? "smtp_error" };
}

const GRAPH_TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const GRAPH_RATE_LIMIT_CODES = new Set([130429, 131056]);
const GRAPH_NO_WHATSAPP_CODE = 131026;
const GRAPH_INVALID_TOKEN_CODE = 190;

export function classifyGraphError(
	status: number | null,
	body: unknown,
	error: unknown,
): ErrorClassification {
	if (error) {
		const name = asRecord(error)?.name;
		const isTimeout = name === "TimeoutError" || name === "AbortError";
		return { permanent: false, code: isTimeout ? "provider_timeout" : "network_error" };
	}

	const metaCode = asRecord(asRecord(body)?.error)?.code;
	if (typeof metaCode === "number") {
		if (GRAPH_TEMPLATE_CODES.has(metaCode)) return { permanent: true, code: "template_unavailable" };
		if (metaCode === GRAPH_NO_WHATSAPP_CODE) return { permanent: true, code: "recipient_unavailable" };
		if (GRAPH_RATE_LIMIT_CODES.has(metaCode)) return { permanent: false, code: "rate_limited" };
		if (metaCode === GRAPH_INVALID_TOKEN_CODE) return { permanent: false, code: "config_error" };
	}

	if (status === 429) return { permanent: false, code: "rate_limited" };
	if (status !== null && status >= 500) return { permanent: false, code: "provider_unavailable" };
	// Sem token válido o erro é nosso (configuração), não do destinatário: tenta de novo depois do ajuste.
	if (status === 401 || status === 403) return { permanent: false, code: "config_error" };
	return { permanent: true, code: "provider_rejected" };
}
