import { describe, expect, it } from "vitest";

import { classifyGraphError, classifySmtpError, TemplateRenderError } from "./errors";

const graphBody = (code: number) => ({ error: { message: "x", type: "OAuthException", code } });

describe("classifySmtpError", () => {
	it("treats a 5xx response as permanent smtp_rejected", () => {
		expect(classifySmtpError({ responseCode: 550 })).toEqual({ permanent: true, code: "smtp_rejected" });
	});

	it("treats a 4xx response as transient", () => {
		expect(classifySmtpError({ responseCode: 451 })).toMatchObject({ permanent: false });
	});

	it.each(["ETIMEDOUT", "ECONNECTION", "ESOCKET"])("provider timeout is transient: %s", (code) => {
		expect(classifySmtpError(Object.assign(new Error("boom"), { code }))).toMatchObject({ permanent: false });
	});

	it.each([530, 534, 535])("treats an SMTP auth response %i as transient smtp_auth", (responseCode) => {
		expect(classifySmtpError({ responseCode })).toEqual({ permanent: false, code: "smtp_auth" });
	});

	it("treats EAUTH as transient smtp_auth", () => {
		expect(classifySmtpError(Object.assign(new Error("boom"), { code: "EAUTH" }))).toEqual({
			permanent: false,
			code: "smtp_auth",
		});
	});

	it("treats EENVELOPE as permanent", () => {
		expect(classifySmtpError(Object.assign(new Error("boom"), { code: "EENVELOPE" }))).toEqual({
			permanent: true,
			code: "smtp_envelope",
		});
	});

	it("keeps other 5xx permanent", () => {
		expect(classifySmtpError({ responseCode: 554 })).toEqual({ permanent: true, code: "smtp_rejected" });
	});

	it("treats an unknown error as transient", () => {
		expect(classifySmtpError(new Error("boom"))).toEqual({ permanent: false, code: "smtp_error" });
		expect(classifySmtpError(undefined)).toEqual({ permanent: false, code: "smtp_error" });
	});
});

describe("classifyGraphError", () => {
	it("provider timeout is transient", () => {
		const timeout = new DOMException("The operation timed out", "TimeoutError");
		expect(classifyGraphError(null, null, timeout)).toEqual({ permanent: false, code: "provider_timeout" });
	});

	it("treats a network error as transient", () => {
		expect(classifyGraphError(null, null, new TypeError("fetch failed"))).toEqual({
			permanent: false,
			code: "network_error",
		});
	});

	it.each([132000, 132001, 132005, 132007, 132012, 132015, 132016])(
		"meta template errors are permanent template_unavailable: %i",
		(code) => {
			expect(classifyGraphError(400, graphBody(code), null)).toEqual({ permanent: true, code: "template_unavailable" });
		},
	);

	it("treats 131026 as permanent recipient_unavailable", () => {
		expect(classifyGraphError(400, graphBody(131026), null)).toEqual({ permanent: true, code: "recipient_unavailable" });
	});

	it.each([130429, 131056, 4, 17, 32, 613, 80007])("treats Meta rate limit %i as transient", (code) => {
		expect(classifyGraphError(400, graphBody(code), null)).toEqual({ permanent: false, code: "rate_limited" });
	});

	it("treats an invalid token as transient config_error", () => {
		expect(classifyGraphError(401, graphBody(190), null)).toEqual({ permanent: false, code: "config_error" });
	});

	it("treats HTTP 429 and 5xx as transient", () => {
		expect(classifyGraphError(429, null, null)).toMatchObject({ permanent: false });
		expect(classifyGraphError(500, null, null)).toMatchObject({ permanent: false });
		expect(classifyGraphError(503, "<html>", null)).toMatchObject({ permanent: false });
	});

	it("treats an unknown 4xx as permanent", () => {
		expect(classifyGraphError(400, graphBody(100), null)).toEqual({ permanent: true, code: "provider_rejected" });
	});
});

describe("TemplateRenderError", () => {
	it("is permanent with the template_render_error code", () => {
		const error = new TemplateRenderError("x");
		expect(error).toMatchObject({ permanent: true, code: "template_render_error" });
		expect(error).toBeInstanceOf(Error);
	});
});
