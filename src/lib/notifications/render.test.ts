import { describe, expect, it } from "vitest";

import { TemplateRenderError } from "./errors";
import { buildWhatsappPayload, renderEmail, validateWhatsappParams } from "./render";

const emailTemplate = {
	email_subject: "Olá {{name}}",
	email_html: "<p>Olá {{name}}</p>",
	email_text: "Olá {{name}}",
};

describe("renderEmail", () => {
	it("escapes HTML in the html body only", () => {
		const result = renderEmail(emailTemplate, { name: `<script>alert("x")</script> & 'y'` });
		expect(result.html).toBe(
			"<p>Olá &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>",
		);
		expect(result.text).toBe(`Olá <script>alert("x")</script> & 'y'`);
	});

	it("removes CR and LF from the subject", () => {
		const result = renderEmail(emailTemplate, { name: "Maria\r\nBcc: x@y.z" });
		expect(result.subject).toBe("Olá MariaBcc: x@y.z");
	});

	it("throws a permanent TemplateRenderError when a placeholder has no parameter", () => {
		expect(() => renderEmail(emailTemplate, {})).toThrow(TemplateRenderError);
	});

	it("does not read the prototype chain for a placeholder named constructor", () => {
		const template = { ...emailTemplate, email_html: "<p>{{constructor}}</p>" };
		expect(() => renderEmail(template, { name: "a" })).toThrow(TemplateRenderError);
	});

	it("throws when the template has no e-mail body", () => {
		expect(() => renderEmail({ ...emailTemplate, email_html: null }, { name: "a" })).toThrow(TemplateRenderError);
	});

	it("renders an SCR-shaped template with the code and the URL", () => {
		const scr = {
			email_subject: "Autorização de consulta SCR — Rainha do Crédito",
			email_html: '<p>{{authorizedName}}, seu código: <b>{{code}}</b></p><a href="{{url}}">Autorizar</a>',
			email_text: "{{authorizedName}}, código {{code}}: {{url}}",
		};
		const result = renderEmail(scr, {
			authorizedName: "João",
			code: "482913",
			url: "https://app.example.test/autorizacao-scr/tok?a=1&b=2",
		});
		expect(result.html).toContain("<b>482913</b>");
		expect(result.html).toContain('href="https://app.example.test/autorizacao-scr/tok?a=1&amp;b=2"');
		expect(result.text).toBe("João, código 482913: https://app.example.test/autorizacao-scr/tok?a=1&b=2");
	});
});

describe("validateWhatsappParams", () => {
	it("accepts plain values", () => {
		expect(validateWhatsappParams({ a: "Maria", b: "a    b", c: "x".repeat(1024) })).toEqual({ ok: true });
	});

	it.each([
		["a line break", "a\nb"],
		["a carriage return", "a\rb"],
		["a tab", "a\tb"],
		["5 spaces in a row", "a     b"],
		["more than 1024 characters", "x".repeat(1025)],
	])("rejects %s", (_name, value) => {
		expect(validateWhatsappParams({ a: value })).toEqual({ ok: false, code: "invalid_params" });
	});
});

describe("buildWhatsappPayload", () => {
	const template = { template_key: "scr_code", wa_template_name: "scr_code", wa_language: "pt_BR", template_params: ["code", "name"] };

	it("puts the parameters in the order of template_params and drops the + from `to`", () => {
		expect(buildWhatsappPayload(template, { name: "Maria", code: "123456" }, "+5563992345615")).toEqual({
			messaging_product: "whatsapp",
			to: "5563992345615",
			type: "template",
			template: {
				name: "scr_code",
				language: { code: "pt_BR" },
				components: [
					{
						type: "body",
						parameters: [
							{ type: "text", text: "123456" },
							{ type: "text", text: "Maria" },
						],
					},
				],
			},
		});
	});

	it("omits components when the template has no parameters", () => {
		const payload = buildWhatsappPayload(
			{ template_key: "hello_world", wa_template_name: "hello_world", wa_language: "en_US", template_params: [] },
			{},
			"+14155550123",
		);
		expect(payload.template).toEqual({ name: "hello_world", language: { code: "en_US" } });
		expect("components" in payload.template).toBe(false);
	});

	it("throws when a parameter has no value", () => {
		expect(() => buildWhatsappPayload(template, { code: "1" }, "+5563992345615")).toThrow(TemplateRenderError);
	});
});

describe("buildWhatsappPayload authentication template", () => {
	const authTemplate = {
		template_key: "phone_verification",
		wa_template_name: "phone_verification",
		wa_language: "pt_BR",
		template_params: ["code"],
	};

	it("puts the code in the body and in the copy-code button", () => {
		const payload = buildWhatsappPayload(authTemplate, { code: "123456" }, "+5563992345615");
		expect(payload.template.components).toEqual([
			{ type: "body", parameters: [{ type: "text", text: "123456" }] },
			{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] },
		]);
	});

	it("adds no button to other templates", () => {
		const payload = buildWhatsappPayload(
			{ ...authTemplate, template_key: "scr_code", wa_template_name: "scr_code" },
			{ code: "123456" },
			"+5563992345615",
		);
		expect(payload.template.components).toEqual([{ type: "body", parameters: [{ type: "text", text: "123456" }] }]);
	});

	it("throws without a code", () => {
		expect(() =>
			buildWhatsappPayload({ ...authTemplate, template_params: [] }, {}, "+5563992345615"),
		).toThrow(TemplateRenderError);
	});
});
