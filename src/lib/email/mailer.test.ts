import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodemailerMock = vi.hoisted(() => {
	const sendMail = vi.fn();
	const createTransport = vi.fn(() => ({ sendMail }));
	return { sendMail, createTransport };
});

vi.mock("server-only", () => ({}));
vi.mock("nodemailer", () => ({ default: { createTransport: nodemailerMock.createTransport } }));

import { isMailConfigured, sendMail, senderDomain } from "./mailer";

const smtpEnv = {
	SMTP_HOST: "smtp.example.test",
	SMTP_USER: "no-reply@example.test",
	SMTP_PASS: "secret",
	SMTP_FROM: "Rainha Cred <no-reply@rainha.example.test>",
};

let configSeq = 0;

beforeEach(() => {
	nodemailerMock.sendMail.mockReset().mockResolvedValue({ messageId: "<generated@x>" });
	nodemailerMock.createTransport.mockClear();
	for (const [key, value] of Object.entries(smtpEnv)) vi.stubEnv(key, value);
	// Senha nova por teste: o transporter em cache é por config e não vaza entre casos.
	vi.stubEnv("SMTP_PASS", `secret-${++configSeq}`);
});

afterEach(() => vi.unstubAllEnvs());

describe("sendMail", () => {
	it("sets 10 s connection, greeting and socket timeouts", async () => {
		await sendMail({ to: "a@b.co", subject: "s", html: "<p>h</p>" });
		expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
			expect.objectContaining({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 }),
		);
	});

	it("reuses one transporter across sends and rebuilds it when the SMTP config changes", async () => {
		await sendMail({ to: "a@b.co", subject: "s", html: "h" });
		await sendMail({ to: "c@d.co", subject: "s", html: "h" });
		expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(1);
		vi.stubEnv("SMTP_HOST", "smtp2.example.test");
		await sendMail({ to: "a@b.co", subject: "s", html: "h" });
		expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(2);
	});

	it("passes the optional messageId and returns the provider messageId", async () => {
		nodemailerMock.sendMail.mockResolvedValue({ messageId: "<n1@rainha.example.test>" });
		const result = await sendMail({ to: "a@b.co", subject: "s", html: "h", messageId: "<n1@rainha.example.test>" });
		expect(nodemailerMock.sendMail).toHaveBeenCalledWith(expect.objectContaining({ messageId: "<n1@rainha.example.test>" }));
		expect(result).toEqual({ messageId: "<n1@rainha.example.test>" });
	});

	it("fails when SMTP is not configured", async () => {
		vi.stubEnv("SMTP_HOST", "");
		expect(isMailConfigured()).toBe(false);
		await expect(sendMail({ to: "a@b.co", subject: "s", html: "h" })).rejects.toThrow("Envio de e-mail não configurado");
	});
});

describe("senderDomain", () => {
	it("reads the domain of the SMTP_FROM address", () => {
		expect(senderDomain()).toBe("rainha.example.test");
	});

	it("reads a bare address in SMTP_FROM", () => {
		vi.stubEnv("SMTP_FROM", "no-reply@bare.example.test");
		expect(senderDomain()).toBe("bare.example.test");
	});

	it("falls back to the SMTP host when the sender has no domain", () => {
		vi.stubEnv("SMTP_FROM", "");
		vi.stubEnv("SMTP_USER", "credit-system");
		expect(senderDomain()).toBe("smtp.example.test");
	});

	it("returns null when SMTP is not configured", () => {
		vi.stubEnv("SMTP_PASS", "");
		expect(senderDomain()).toBeNull();
	});
});
