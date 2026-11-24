import { describe, expect, it, vi } from "vitest";

import { downloadPdf, parseFilename, type PdfDownloadDeps } from "./pdf-download";

function makeDeps(over: Partial<PdfDownloadDeps> = {}, res?: Response): PdfDownloadDeps {
	return {
		fetchFn: vi.fn().mockResolvedValue(
			res ?? new Response("%PDF", { status: 200, headers: { "Content-Disposition": 'attachment; filename="dossie.pdf"' } }),
		),
		nav: {},
		createObjectURL: vi.fn().mockReturnValue("blob:x"),
		revokeObjectURL: vi.fn(),
		clickAnchor: vi.fn(),
		...over,
	};
}

describe("parseFilename", () => {
	it("lê filename entre aspas", () => {
		expect(parseFilename('attachment; filename="a b.pdf"')).toBe("a b.pdf");
	});
	it("lê filename*", () => {
		expect(parseFilename("attachment; filename*=UTF-8''p%C3%A3o.pdf")).toBe("pão.pdf");
	});
	it("usa padrão sem header ou sem filename", () => {
		expect(parseFilename(null)).toBe("pesquisa.pdf");
		expect(parseFilename("attachment")).toBe("pesquisa.pdf");
	});
});

describe("downloadPdf", () => {
	it("compartilha o arquivo quando canShare é true", async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ nav: { canShare: () => true, share } });
		expect(await downloadPdf("/pdf", deps)).toEqual({ kind: "shared" });
		const file = share.mock.calls[0][0].files[0] as File;
		expect(file.type).toBe("application/pdf");
		expect(file.name).toBe("dossie.pdf");
		expect(deps.clickAnchor).not.toHaveBeenCalled();
	});

	it("baixa por âncora quando canShare não existe", async () => {
		const deps = makeDeps();
		expect(await downloadPdf("/pdf", deps)).toEqual({ kind: "downloaded" });
		expect(deps.clickAnchor).toHaveBeenCalledWith("blob:x", "dossie.pdf");
		expect(deps.revokeObjectURL).toHaveBeenCalledWith("blob:x");
	});

	it("resposta não OK vira erro e não compartilha", async () => {
		const share = vi.fn();
		const deps = makeDeps({ nav: { canShare: () => true, share } }, new Response("no", { status: 500 }));
		const result = await downloadPdf("/pdf", deps);
		expect(result.kind).toBe("error");
		expect(share).not.toHaveBeenCalled();
	});

	it("share falha com outro erro: cai no download por âncora", async () => {
		const denied = Object.assign(new Error("x"), { name: "NotAllowedError" });
		const deps = makeDeps({ nav: { canShare: () => true, share: vi.fn().mockRejectedValue(denied) } });
		expect(await downloadPdf("/pdf", deps)).toEqual({ kind: "downloaded" });
		expect(deps.clickAnchor).toHaveBeenCalledWith("blob:x", "dossie.pdf");
		expect(deps.revokeObjectURL).toHaveBeenCalledWith("blob:x");
	});

	it("AbortError vira cancelled", async () => {
		const abort = Object.assign(new Error("x"), { name: "AbortError" });
		const deps = makeDeps({ nav: { canShare: () => true, share: vi.fn().mockRejectedValue(abort) } });
		expect(await downloadPdf("/pdf", deps)).toEqual({ kind: "cancelled" });
	});
});
