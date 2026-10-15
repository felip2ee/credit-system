import { beforeEach, describe, expect, it, vi } from "vitest";

const mailer = vi.hoisted(() => ({ sendMail: vi.fn(), senderDomain: vi.fn() }));
vi.mock("@/lib/email/mailer", () => mailer);

import type { ClaimedNotification } from "../types";
import { sendEmailNotification } from "./email";

const notification: ClaimedNotification = {
	id: "0b8f6f0e-1111-2222-3333-444455556666",
	lease_id: "l-1",
	channel: "email",
	recipient: "maria@exemplo.com",
	params: { name: "<b>Maria</b>" },
	attempts: 1,
	opted_out: false,
	template_key: "platform_test",
	template_version: 1,
	template_params: ["name"],
	email_subject: "Olá {{name}}",
	email_html: "<p>{{name}}</p>",
	email_text: "{{name}}",
	wa_template_name: null,
	wa_language: null,
};

beforeEach(() => {
	mailer.sendMail.mockReset().mockResolvedValue({ messageId: "<provider@id>" });
	mailer.senderDomain.mockReset().mockReturnValue("rainha.example.test");
});

describe("sendEmailNotification", () => {
	it("renders the template and sends with a Message-ID built from the notification id", async () => {
		const result = await sendEmailNotification(notification);

		expect(result).toEqual({ ok: true, providerMessageId: "<provider@id>" });
		expect(mailer.sendMail).toHaveBeenCalledWith({
			to: "maria@exemplo.com",
			subject: "Olá <b>Maria</b>",
			html: "<p>&lt;b&gt;Maria&lt;/b&gt;</p>",
			text: "<b>Maria</b>",
			messageId: "<0b8f6f0e-1111-2222-3333-444455556666@rainha.example.test>",
		});
	});

	it("is permanent channel_not_configured when SMTP is missing", async () => {
		mailer.senderDomain.mockReturnValue(null);
		expect(await sendEmailNotification(notification)).toEqual({
			ok: false,
			permanent: true,
			code: "channel_not_configured",
		});
		expect(mailer.sendMail).not.toHaveBeenCalled();
	});

	it("is permanent template_render_error when a placeholder has no parameter", async () => {
		expect(await sendEmailNotification({ ...notification, params: {} })).toEqual({
			ok: false,
			permanent: true,
			code: "template_render_error",
		});
		expect(mailer.sendMail).not.toHaveBeenCalled();
	});

	it("classifies SMTP failures", async () => {
		mailer.sendMail.mockRejectedValueOnce(Object.assign(new Error("550 no such user"), { responseCode: 550 }));
		expect(await sendEmailNotification(notification)).toEqual({ ok: false, permanent: true, code: "smtp_rejected" });

		mailer.sendMail.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
		expect(await sendEmailNotification(notification)).toMatchObject({ ok: false, permanent: false });
	});
});
