import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	registerClient: vi.fn(),
	confirmEmailVerification: vi.fn(),
	hashPassword: vi.fn(),
}));

vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "vitest-agent" }),
}));
vi.mock("better-auth/crypto", () => ({ hashPassword: state.hashPassword }));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://app.example.test" } }));
vi.mock("@/lib/account/queries", () => ({
	registerClient: state.registerClient,
	confirmEmailVerification: state.confirmEmailVerification,
}));

import { confirmEmailAction, registerClientAction } from "./register";

const DOCUMENT = "529.982.247-25";
const EMAIL = "Maria.Secreta@Example.test";
const PHONE = "(63) 99999-1234";
const PASSWORD = "SenhaForte#2026ab";
const TOKEN = "A".repeat(43);

const form = {
	slug: "bureau-teste",
	type: "PF",
	name: "Maria Teste",
	document: DOCUMENT,
	email: EMAIL,
	phone: PHONE,
	password: PASSWORD,
	confirm: PASSWORD,
	acceptedTerms: true,
	termsVersion: 1,
	privacyVersion: 1,
};

beforeEach(() => {
	vi.clearAllMocks();
	state.hashPassword.mockResolvedValue("hashed-password-value-000000");
	state.registerClient.mockResolvedValue({ ok: true, userId: "user-1" });
	state.confirmEmailVerification.mockResolvedValue({ ok: true });
});

describe("registerClientAction", () => {
	it("registers with normalized values, request meta and the site url", async () => {
		await expect(registerClientAction(form)).resolves.toEqual({ error: null });

		expect(state.registerClient).toHaveBeenCalledWith({
			slug: "bureau-teste",
			type: "PF",
			name: "Maria Teste",
			documentDigits: "52998224725",
			email: "maria.secreta@example.test",
			phoneE164: "+5563999991234",
			passwordHash: "hashed-password-value-000000",
			termsVersion: 1,
			privacyVersion: 1,
			ip: "203.0.113.9",
			userAgent: "vitest-agent",
			emailToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			siteUrl: "https://app.example.test",
		});
	});

	it.each([
		["rate_limited", "Muitas tentativas de cadastro. Tente de novo em uma hora."],
		["bureau_not_found", "Bureau não encontrado."],
		["outdated_terms", "Os termos foram atualizados. Recarregue a página e aceite a nova versão."],
		["document_in_use", "Documento já cadastrado neste Bureau. Peça o acesso ao Bureau."],
		["email_in_use", "E-mail já cadastrado. Entre com sua senha ou recupere o acesso."],
		["invalid_input", "Dados inválidos."],
	])("maps %s to its message", async (reason, message) => {
		state.registerClient.mockResolvedValue({ ok: false, reason });

		await expect(registerClientAction(form)).resolves.toEqual({ error: message });
	});

	it("returns the first zod message and does not touch the database", async () => {
		const result = await registerClientAction({ ...form, document: "111.111.111-11" });

		expect(result).toEqual({ error: "CPF inválido." });
		expect(state.hashPassword).not.toHaveBeenCalled();
		expect(state.registerClient).not.toHaveBeenCalled();
	});

	it("refuses an invalid mobile number without calling registerClient", async () => {
		const result = await registerClientAction({ ...form, phone: "6399999123" });

		expect(result).toEqual({ error: "Celular inválido. Use DDD e número." });
		expect(state.registerClient).not.toHaveBeenCalled();
	});

	it("turns an exception into the generic message", async () => {
		state.registerClient.mockRejectedValue(Object.assign(new Error(`falhou ${DOCUMENT} ${EMAIL}`), { code: "ECONNRESET" }));

		await expect(registerClientAction(form)).resolves.toEqual({
			error: "Não foi possível concluir o cadastro. Tente novamente.",
		});
	});

	it("audit, logs and errors carry no document, raw email, raw phone, token or code", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		state.registerClient.mockRejectedValue(Object.assign(new Error(`falhou ${DOCUMENT} ${EMAIL} ${PHONE}`), { code: "ECONNRESET" }));

		const result = await registerClientAction(form);

		const emailToken = state.registerClient.mock.calls[0][0].emailToken as string;
		const logged = JSON.stringify(spy.mock.calls);
		const secrets = [DOCUMENT, "52998224725", EMAIL, EMAIL.toLowerCase(), PHONE, "+5563999991234", PASSWORD, emailToken];
		for (const secret of secrets) {
			expect(logged).not.toContain(secret);
			expect(JSON.stringify(result)).not.toContain(secret);
		}
		expect(logged).toContain("ECONNRESET");
		spy.mockRestore();
	});
});

describe("confirmEmailAction", () => {
	it("confirms a well-formed token", async () => {
		await expect(confirmEmailAction(TOKEN)).resolves.toEqual({ error: null });
		expect(state.confirmEmailVerification).toHaveBeenCalledWith(TOKEN);
	});

	it.each([undefined, "", "curto", `${"A".repeat(42)}!`, 42])("treats a malformed token (%s) as invalid without a query", async (token) => {
		await expect(confirmEmailAction(token)).resolves.toEqual({
			error: "Link inválido ou já usado. Entre no portal e peça um novo e-mail.",
		});
		expect(state.confirmEmailVerification).not.toHaveBeenCalled();
	});

	it.each([
		["invalid", "Link inválido ou já usado. Entre no portal e peça um novo e-mail."],
		["expired", "Link expirado. Entre no portal e peça um novo e-mail."],
	])("maps %s to its message", async (reason, message) => {
		state.confirmEmailVerification.mockResolvedValue({ ok: false, reason });

		await expect(confirmEmailAction(TOKEN)).resolves.toEqual({ error: message });
	});

	it("turns an exception into the generic message without logging the token", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		state.confirmEmailVerification.mockRejectedValue(new Error(`falhou ${TOKEN}`));

		await expect(confirmEmailAction(TOKEN)).resolves.toEqual({
			error: "Não foi possível confirmar o e-mail. Tente novamente.",
		});
		expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
		spy.mockRestore();
	});
});
