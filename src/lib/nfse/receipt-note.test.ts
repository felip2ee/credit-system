import { describe, expect, it } from "vitest";

import { nfseNoteFor } from "./receipt-note";

describe("nfseNoteFor", () => {
	it("links the note when the url exists", () => {
		expect(nfseNoteFor("issued", "https://nfse.example/1.pdf")).toEqual({ kind: "link", url: "https://nfse.example/1.pdf" });
	});

	it.each([
		["issued", "Nota emitida"],
		["pending", "Nota em emissão"],
		["failed", "Nota em análise"],
	])("shows %s without a url as %s", (status, text) => {
		expect(nfseNoteFor(status, null)).toEqual({ kind: "text", text });
	});

	it("shows nothing when the note was never requested", () => {
		expect(nfseNoteFor("not_requested", null)).toBeNull();
	});
});
