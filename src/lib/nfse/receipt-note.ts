// Texto da nota fiscal na tela de recibo do cliente. Só o estado público: nada de falha interna do Asaas.
export type NfseNote = { kind: "link"; url: string } | { kind: "text"; text: string } | null;

function isHttpUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

// Só http(s) vira link: javascript:, data: etc. caem no texto do estado.
export function nfseNoteFor(status: string, url: string | null): NfseNote {
	if (url && isHttpUrl(url)) return { kind: "link", url };
	if (status === "issued") return { kind: "text", text: "Nota emitida" };
	if (status === "pending") return { kind: "text", text: "Nota em emissão" };
	if (status === "failed") return { kind: "text", text: "Nota em análise" };
	return null;
}
