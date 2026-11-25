export const DEFAULT_PDF_FILENAME = "pesquisa.pdf";
// Safari/iOS pode cancelar o download se a URL for revogada logo após o clique.
export const REVOKE_DELAY_MS = 30_000;
const PDF_ERROR_MESSAGE = "Não foi possível gerar o PDF. Tente novamente.";

export type PdfDownloadResult = { kind: "shared" | "downloaded" | "cancelled" } | { kind: "error"; message: string };

export interface PdfDownloadDeps {
	fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
	nav: {
		canShare?: (data: ShareData) => boolean;
		share?: (data: ShareData) => Promise<void>;
	};
	createObjectURL: (blob: Blob) => string;
	revokeObjectURL: (url: string) => void;
	clickAnchor: (url: string, filename: string) => void;
	setTimer: (fn: () => void, ms: number) => unknown;
}

// Lê filename (RFC 5987 ou simples) do Content-Disposition; cai em pesquisa.pdf.
export function parseFilename(header: string | null): string {
	if (!header) return DEFAULT_PDF_FILENAME;
	const star = /filename\*\s*=\s*(?:[\w-]+'[^']*')?([^;]+)/i.exec(header)?.[1]?.trim();
	if (star) {
		try {
			return decodeURIComponent(star.replace(/^"|"$/g, "")) || DEFAULT_PDF_FILENAME;
		} catch {
			// segue para o filename simples
		}
	}
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
	const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
	return name || DEFAULT_PDF_FILENAME;
}

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

export async function downloadPdf(href: string, deps: PdfDownloadDeps): Promise<PdfDownloadResult> {
	const { fetchFn, nav, createObjectURL, revokeObjectURL, clickAnchor, setTimer } = deps;
	try {
		const res = await fetchFn(href, { credentials: "same-origin" });
		// Sessão expirada: o fetch segue o redirect para /login e devolve HTML com 200.
		if (!res.ok || !res.headers.get("Content-Type")?.includes("application/pdf")) return { kind: "error", message: PDF_ERROR_MESSAGE };
		const filename = parseFilename(res.headers.get("Content-Disposition"));
		const blob = await res.blob();
		const file = new File([blob], filename, { type: "application/pdf" });
		if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
			try {
				await nav.share({ files: [file] });
				return { kind: "shared" };
			} catch (error) {
				if (isAbortError(error)) return { kind: "cancelled" };
				// ex.: NotAllowedError quando o gesto do usuário expirou durante o fetch; cai no download por âncora
			}
		}
		const url = createObjectURL(blob);
		try {
			clickAnchor(url, filename);
		} finally {
			setTimer(() => revokeObjectURL(url), REVOKE_DELAY_MS);
		}
		return { kind: "downloaded" };
	} catch {
		return { kind: "error", message: PDF_ERROR_MESSAGE };
	}
}
