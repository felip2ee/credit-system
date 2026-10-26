import { describe, expect, it } from "vitest";

import { BRAND_NAME } from "@/lib/brand/brand";

import { TemplateRenderError } from "./errors";
import { buildPushPayload } from "./push-payload";

const BODIES = {
	scr_partner_authorized: "Um sócio autorizou sua consulta",
	research_released: "Sua consulta está pronta",
	commission_received: "Você recebeu uma comissão",
	commission_available: "Você tem comissão disponível para saque",
} as const;

describe("buildPushPayload", () => {
	it.each(Object.entries(BODIES))("%s uses the brand title, its fixed body and the given url", (key, body) => {
		expect(buildPushPayload(key, { url: "/portal/afiliacao" })).toEqual({
			title: BRAND_NAME,
			body,
			url: "/portal/afiliacao",
		});
	});

	it("output has only title, body and url", () => {
		const payload = buildPushPayload("research_released", {
			url: "/portal/pesquisas/abc",
			clientName: "Maria",
			document: "12345678901",
		});
		expect(Object.keys(JSON.parse(JSON.stringify(payload))).sort()).toEqual(["body", "title", "url"]);
		expect(JSON.stringify(payload)).not.toContain("Maria");
		expect(JSON.stringify(payload)).not.toContain("12345678901");
	});

	it("unknown template key is rejected", () => {
		expect(() => buildPushPayload("platform_test", { url: "/portal" })).toThrow(TemplateRenderError);
	});

	it.each([undefined, "", "portal", "https://evil.com", "//evil.com", "http://evil.com/x", "/\\evil.com", "/portal\\..\\x"])(
		"absolute url is rejected: %s",
		(url) => {
			const params: Record<string, string> = url === undefined ? {} : { url };
			expect(() => buildPushPayload("commission_received", params)).toThrow(TemplateRenderError);
		},
	);
});
