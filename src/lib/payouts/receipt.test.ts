import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	root: "",
	scan: { mode: "clean" as "clean" | "infected" | "down", seen: [] as Buffer[] },
}));

vi.mock("@/lib/config", async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	h.root = mkdtempSync(join(tmpdir(), "receipts-"));
	return { config: { documentRoot: h.root } };
});

vi.mock("@/lib/documents/clamav", () => {
	class ScannerUnavailableError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "ScannerUnavailableError";
		}
	}
	return {
		ScannerUnavailableError,
		scanStream: async (source: AsyncIterable<Uint8Array>) => {
			if (h.scan.mode === "down") throw new ScannerUnavailableError("down");
			for await (const chunk of source) h.scan.seen.push(Buffer.from(chunk));
			return h.scan.mode === "infected" ? "Eicar-Test-Signature" : null;
		},
	};
});

import { ScannerUnavailableError } from "@/lib/documents/clamav";

import { MAX_RECEIPT_BYTES, openPayoutReceipt, ReceiptRejectedError, storePayoutReceipt } from "./receipt";

const PNG = Buffer.concat([
	Buffer.from("89504e470d0a1a0a", "hex"),
	Buffer.from("00000000".repeat(4)),
	Buffer.from("0000000049454e44ae426082", "hex"),
]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const JPEG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("0010".repeat(8)), Buffer.from("ffd9", "hex")]);

const file = (content: Buffer, name = "comprovante.pdf", type = "application/pdf") =>
	new File([new Uint8Array(content)], name, { type });
const dirs = () => ({
	quarantine: existsSync(path.join(h.root, "quarantine")) ? readdirSync(path.join(h.root, "quarantine")) : [],
	objects: existsSync(path.join(h.root, "objects")) ? readdirSync(path.join(h.root, "objects")) : [],
});

beforeEach(() => {
	h.scan.mode = "clean";
	h.scan.seen = [];
	rmSync(path.join(h.root, "quarantine"), { recursive: true, force: true });
	rmSync(path.join(h.root, "objects"), { recursive: true, force: true });
});
afterAll(() => rmSync(h.root, { recursive: true, force: true }));

describe("storePayoutReceipt accepts", () => {
	it.each([
		["pdf", PDF, "application/pdf"],
		["png", PNG, "image/png"],
		["jpeg", JPEG, "image/jpeg"],
	])("a valid %s: stores one object, returns key, mime and sha256, leaves no quarantine", async (_n, content, mime) => {
		const result = await storePayoutReceipt(file(content));

		expect(result.mime).toBe(mime);
		expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
		expect(result.objectKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
		expect(path.isAbsolute(result.objectKey)).toBe(false);
		expect(readFileSync(path.join(h.root, "objects", result.objectKey))).toEqual(content);
		expect(dirs().quarantine).toEqual([]);
		expect(Buffer.concat(h.scan.seen)).toEqual(content);
	});

	it("ignores the declared MIME and the file name: a PNG sent as .pdf is stored as image/png", async () => {
		const result = await storePayoutReceipt(file(PNG, "foto.pdf", "application/pdf"));

		expect(result.mime).toBe("image/png");
	});
});

describe("storePayoutReceipt rejects and cleans the quarantine", () => {
	async function expectRejected(input: File, reason: string) {
		const error = await storePayoutReceipt(input).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ReceiptRejectedError);
		expect((error as ReceiptRejectedError).reason).toBe(reason);
		expect(dirs()).toEqual({ quarantine: [], objects: [] });
	}

	it("a file over 5 MB", async () => {
		await expectRejected(file(Buffer.concat([PDF, Buffer.alloc(MAX_RECEIPT_BYTES)])), "too_large");
	});

	it("an empty file", async () => {
		await expectRejected(file(Buffer.alloc(0)), "invalid_type");
	});

	it("content that is not PDF, PNG or JPEG although declared application/pdf", async () => {
		await expectRejected(file(Buffer.from("<html><script>alert(1)</script></html>")), "invalid_type");
		await expectRejected(file(Buffer.from("MZ\x90\x00 executable")), "invalid_type");
	});

	it("a polyglot: a PDF header that carries a PNG signature and no PDF trailer", async () => {
		await expectRejected(file(Buffer.concat([Buffer.from("%PDF-1.4\n"), PNG])), "invalid_type");
	});

	it("a PNG with data appended after IEND", async () => {
		await expectRejected(file(Buffer.concat([PNG, Buffer.from("PK\x03\x04 zip payload")])), "invalid_type");
	});

	it("a file ClamAV flags as infected", async () => {
		h.scan.mode = "infected";
		await expectRejected(file(PDF), "infected");
	});

	it("any file when the scanner is unavailable (fails closed)", async () => {
		h.scan.mode = "down";
		const error = await storePayoutReceipt(file(PDF)).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ScannerUnavailableError);
		expect(dirs()).toEqual({ quarantine: [], objects: [] });
	});
});

describe("openPayoutReceipt", () => {
	it("streams the stored bytes with their size", async () => {
		const { objectKey } = await storePayoutReceipt(file(PDF));

		const opened = await openPayoutReceipt(objectKey);

		expect(opened).not.toBeNull();
		expect(opened!.size).toBe(PDF.length);
		expect(Buffer.from(await new Response(opened!.body).arrayBuffer())).toEqual(PDF);
	});

	it("returns null for a missing object and for a traversal key", async () => {
		expect(await openPayoutReceipt("ab/00000000-0000-0000-0000-000000000000")).toBeNull();
		expect(await openPayoutReceipt("../../etc/passwd")).toBeNull();
	});
});
