// Texto da nota fiscal na tela de recibo do cliente. Só o estado público: nada de falha interna do Asaas.
export type NfseNote = { kind: "link"; url: string } | { kind: "text"; text: string } | null;

export function nfseNoteFor(status: string, url: string | null): NfseNote {
	if (url) return { kind: "link", url };
	if (status === "issued") return { kind: "text", text: "Nota emitida" };
	if (status === "pending") return { kind: "text", text: "Nota em emissão" };
	if (status === "failed") return { kind: "text", text: "Nota em análise" };
	return null;
}
