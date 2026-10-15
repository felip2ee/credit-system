import { TemplateRenderError } from "./errors";
import type { ClaimedNotification } from "./types";

type EmailTemplate = Pick<ClaimedNotification, "email_subject" | "email_html" | "email_text">;
type WhatsappTemplate = Pick<ClaimedNotification, "template_key" | "wa_template_name" | "wa_language" | "template_params">;

const MARKER = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;
const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
// Regras da Meta para o valor de um parâmetro de template.
const WHATSAPP_PARAM_MAX_LENGTH = 1024;
const WHATSAPP_PARAM_MAX_SPACES = 4;

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function fill(source: string | null, params: Record<string, string>, escape?: (value: string) => string): string {
	if (source === null) throw new TemplateRenderError("E-mail template body is missing");
	return source.replace(MARKER, (_marker, name: string) => {
		// hasOwn: {{constructor}} não pode ler a cadeia de protótipos.
		const value = Object.hasOwn(params, name) ? params[name] : undefined;
		if (value === undefined) throw new TemplateRenderError(`Template placeholder "${name}" has no parameter`);
		return escape ? escape(value) : value;
	});
}

export function renderEmail(template: EmailTemplate, params: Record<string, string>): RenderedEmail {
	return {
		// CR e LF no assunto abririam a porta para injeção de cabeçalho.
		subject: fill(template.email_subject, params).replace(/[\r\n]/g, ""),
		html: fill(template.email_html, params, escapeHtml),
		text: fill(template.email_text, params),
	};
}

export type ParamsValidation = { ok: true } | { ok: false; code: "invalid_params" };

export function validateWhatsappParams(params: Record<string, string>): ParamsValidation {
	const spaces = new RegExp(` {${WHATSAPP_PARAM_MAX_SPACES + 1},}`);
	const isInvalid = (value: string) =>
		/[\r\n\t]/.test(value) || spaces.test(value) || value.length > WHATSAPP_PARAM_MAX_LENGTH;
	return Object.values(params).some(isInvalid) ? { ok: false, code: "invalid_params" } : { ok: true };
}

// Templates de autenticação da Meta levam o código também no botão "copiar código".
export const AUTH_CODE_TEMPLATE_KEYS: readonly string[] = ["phone_verification"];

export function buildWhatsappPayload(template: WhatsappTemplate, params: Record<string, string>, to: string) {
	if (template.wa_template_name === null || template.wa_language === null) {
		throw new TemplateRenderError("WhatsApp template name or language is missing");
	}
	const parameters = template.template_params.map((name) => {
		const text = Object.hasOwn(params, name) ? params[name] : undefined;
		if (text === undefined) throw new TemplateRenderError(`Template parameter "${name}" has no value`);
		return { type: "text" as const, text };
	});
	const components: object[] = parameters.length > 0 ? [{ type: "body" as const, parameters }] : [];
	if (AUTH_CODE_TEMPLATE_KEYS.includes(template.template_key)) {
		const code = Object.hasOwn(params, "code") ? params.code : undefined;
		if (code === undefined) throw new TemplateRenderError('Authentication template has no "code" parameter');
		// Formato do botão "copiar código" (Cloud API, template de autenticação): type "button", sub_type "url", index "0",
		// código como parâmetro de texto. Conferido por conhecimento da doc da Meta; Context7 estava sem autenticação.
		components.push({ type: "button" as const, sub_type: "url" as const, index: "0", parameters: [{ type: "text" as const, text: code }] });
	}
	return {
		messaging_product: "whatsapp" as const,
		to: to.replace(/^\+/, ""),
		type: "template" as const,
		template: {
			name: template.wa_template_name,
			language: { code: template.wa_language },
			...(components.length > 0 && { components }),
		},
	};
}
