// Classifica falha de provedor em permanente (não adianta tentar de novo) ou transitória.
// Códigos da Graph API conferidos em
// developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes (14/10/2026):
// 130429/131056 limite de taxa; 131026 sem WhatsApp; 132000/132001/132005/132007/132012 parâmetro ou
// template inválido, 132015 pausado, 132016 desativado; 190 token inválido ou expirado.
// Limite de taxa do app ou da conta (conferidos em 15/10/2026): 4 e 17 no guia de erros da Graph API, 80007 na página de
// códigos do WhatsApp. 32 (Pages) e 613 (limite personalizado) vêm do guia de rate limiting da Graph API, que não foi relido.

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

// 530/534/535: o servidor recusou as credenciais (erro nosso, não do destinatário); tenta de novo depois do ajuste.
const SMTP_AUTH_RESPONSE_CODES = new Set([530, 534, 535]);

export function classifySmtpError(error: unknown): ErrorClassification {
	const info = asRecord(error);
	const responseCode = typeof info?.responseCode === "number" ? info.responseCode : null;
	const errorCode = typeof info?.code === "string" ? info.code : "";
	if (errorCode === "EAUTH" || (responseCode !== null && SMTP_AUTH_RESPONSE_CODES.has(responseCode))) {
		return { permanent: false, code: "smtp_auth" };
	}
	// Remetente ou destinatário recusado antes do envio: repetir não muda nada.
	if (errorCode === "EENVELOPE") return { permanent: true, code: "smtp_envelope" };
	if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
		return { permanent: true, code: "smtp_rejected" };
	}
	if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
		return { permanent: false, code: "smtp_deferred" };
	}
	return { permanent: false, code: SMTP_TRANSIENT_CODES[errorCode] ?? "smtp_error" };
}

const GRAPH_TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const GRAPH_RATE_LIMIT_CODES = new Set([130429, 131056, 4, 17, 32, 613, 80007]);
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
