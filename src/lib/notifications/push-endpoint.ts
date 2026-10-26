import { parse as legacyParse } from "node:url";

// Allowlist dos serviços de push dos navegadores. O endpoint vem do cliente e o servidor faz POST nele:
// sem a lista, um cliente apontaria o envio para um host interno (SSRF).
export const PUSH_SERVICE_HOSTS: readonly string[] = [
	"fcm.googleapis.com",
	"updates.push.services.mozilla.com",
	"web.push.apple.com",
	".notify.windows.com",
];
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;
const HOSTNAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

function isAllowedHost(host: string): boolean {
	return PUSH_SERVICE_HOSTS.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
}

export function isAllowedPushEndpoint(value: string): boolean {
	// Barra invertida: WHATWG a trata como "/", o parser legado nem sempre. Endpoint real nunca a tem.
	if (value.length > PUSH_ENDPOINT_MAX_LENGTH || value.includes("\\")) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return false;
	// O web-push usa url.parse (legado), que lê o host diferente do WHATWG em casos como "evil;.notify.windows.com":
	// só vale se os dois leitores concordam e o host tem só letras, dígitos, hífen e ponto.
	if (!HOSTNAME_PATTERN.test(url.hostname)) return false;
	try {
		// url.parse (legado) é o parser que o web-push usa: precisamos do mesmo resultado que ele.
		if (legacyParse(value).hostname !== url.hostname) return false;
	} catch {
		return false;
	}
	return isAllowedHost(url.hostname);
}
