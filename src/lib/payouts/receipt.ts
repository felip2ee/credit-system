// Comprovante de repasse: upload não confiável. Fluxo: quarentena -> tipo por magic bytes -> ClamAV (falha fechada) -> objeto.
// Só a chave relativa sai de src/lib/documents. Nunca registre nome nem conteúdo do arquivo em log.
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { ScannerUnavailableError, scanStream } from "@/lib/documents/clamav";
import {
	commitQuarantine,
	openObject,
	quarantineStream,
	removeObject,
	removeQuarantine,
	writeQuarantine,
} from "@/lib/documents/storage";

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

export type ReceiptMime = "application/pdf" | "image/png" | "image/jpeg";
export type StoredReceipt = {
	objectKey: string;
	mime: ReceiptMime;
	sha256: string;
};
export type ReceiptRejection = "too_large" | "invalid_type" | "infected";

export class ReceiptRejectedError extends Error {
	constructor(readonly reason: ReceiptRejection) {
		super(`receipt rejected: ${reason}`);
		this.name = "ReceiptRejectedError";
	}
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_IEND = Buffer.from("49454e44ae426082", "hex");
const JPEG_SIGNATURE = Buffer.from("ffd8ff", "hex");
const JPEG_EOI = Buffer.from("ffd9", "hex");
const PDF_SIGNATURE = Buffer.from("%PDF-");
const PDF_EOF = "%%EOF";
const PDF_EOF_WINDOW = 1024;
const HEAD_BYTES = 8;

// Tipo pelo conteúdo, nunca pelo MIME ou nome enviados. Cabeçalho e rodapé têm de bater:
// dado anexado depois do fim do formato (polyglot) reprova.
// shortcut: JPEG com preenchimento após o EOI é recusado; relaxe só se um comprovante real falhar.
function detectMime(head: Buffer, tail: Buffer): ReceiptMime | null {
	if (head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		return tail.subarray(-PNG_IEND.length).equals(PNG_IEND)
			? "image/png"
			: null;
	}
	if (head.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
		return tail.subarray(-JPEG_EOI.length).equals(JPEG_EOI)
			? "image/jpeg"
			: null;
	}
	if (head.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
		return tail.toString("latin1").includes(PDF_EOF) ? "application/pdf" : null;
	}
	return null;
}

export async function storePayoutReceipt(file: File): Promise<StoredReceipt> {
	if (file.size > MAX_RECEIPT_BYTES)
		throw new ReceiptRejectedError("too_large");

	const id = randomUUID();
	const hash = createHash("sha256");
	let head = Buffer.alloc(0);
	let tail = Buffer.alloc(0);

	try {
		// A contagem em fluxo vale mesmo que file.size minta.
		await writeQuarantine(
			id,
			file.stream() as unknown as AsyncIterable<Uint8Array>,
			(chunk, bytesSoFar) => {
				if (bytesSoFar > MAX_RECEIPT_BYTES)
					throw new ReceiptRejectedError("too_large");
				hash.update(chunk);
				if (head.length < HEAD_BYTES)
					head = Buffer.concat([head, chunk]).subarray(0, HEAD_BYTES);
				tail = Buffer.concat([tail, chunk]).subarray(-PDF_EOF_WINDOW);
			},
		);

		const mime = detectMime(head, tail);
		if (!mime) throw new ReceiptRejectedError("invalid_type");

		// ScannerUnavailableError sobe: arquivo sem varredura nunca é aceito.
		const signature = await scanStream(quarantineStream(id));
		if (signature !== null) throw new ReceiptRejectedError("infected");

		const objectKey = await commitQuarantine(id);
		return { objectKey, mime, sha256: hash.digest("hex") };
	} catch (error) {
		await removeQuarantine(id).catch(() => {});
		throw error;
	}
}

export type OpenedReceipt = { body: ReadableStream<Uint8Array>; size: number };

// null para objeto ausente ou chave fora de objects/: o chamador responde 404 sem distinguir.
export async function openPayoutReceipt(
	objectKey: string,
): Promise<OpenedReceipt | null> {
	let handle;
	try {
		handle = await openObject(objectKey);
	} catch {
		return null;
	}
	const { size } = await handle.stat();
	// createReadStream fecha o handle ao terminar ou ao ser cancelado.
	const body = Readable.toWeb(
		handle.createReadStream(),
	) as unknown as ReadableStream<Uint8Array>;
	return { body, size };
}

export async function discardPayoutReceipt(objectKey: string): Promise<void> {
	await removeObject(objectKey);
}

export { ScannerUnavailableError };
