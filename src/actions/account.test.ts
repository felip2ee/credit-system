import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const TX_CLIENT = { tx: true };

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	requestEmail: vi.fn(),
	requestPhone: vi.fn(),
	confirmPhone: vi.fn(),
	acceptLegal: vi.fn(),
	setChannel: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "vitest-agent" }),
}));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://app.example.test" } }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: BUREAU_ID, supportSessionId: null, permissions: [] };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work(TX_CLIENT),
}));
vi.mock("@/lib/account/queries", () => ({
	requestEmailVerification: state.requestEmail,
	requestPhoneVerification: state.requestPhone,
	confirmPhoneVerification: state.confirmPhone,
	acceptLegalDocuments: state.acceptLegal,
	setNotificationChannel: state.setChannel,
}));

import { revalidatePath } from "next/cache";

import {
	acceptLegalDocumentsAction,
	confirmPhoneAction,
	requestPhoneVerificationAction,
	resendEmailVerificationAction,
	setNotificationChannelAction,
} from "./account";

const NOT_ALLOWED = "Ação não permitida.";
const GENERIC = "Não foi possível concluir. Tente novamente.";
const OK = { error: null };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	for (const fn of [state.requestEmail, state.requestPhone, state.confirmPhone, state.acceptLegal, state.setChannel]) {
		fn.mockResolvedValue({ ok: true });
	}
});

const calls = {
	resendEmail: () => resendEmailVerificationAction(),
	requestPhone: () => requestPhoneVerificationAction({ phone: "(63) 99999-1234" }),
	confirmPhone: () => confirmPhoneAction({ code: "123456" }),
	acceptLegal: () => acceptLegalDocumentsAction({ termsVersion: 1, privacyVersion: 1 }),
	setChannel: () => setNotificationChannelAction({ channel: "whatsapp" }),
};
const queries = [state.requestEmail, state.requestPhone, state.confirmPhone, state.acceptLegal, state.setChannel];

describe("authorization", () => {
	it.each(["operator", "bureau_admin", "superadmin"])("%s is refused by every account action", async (role) => {
		state.role = role;

		for (const call of Object.values(calls)) expect(await call()).toEqual({ error: NOT_ALLOWED });
		for (const query of queries) expect(query).not.toHaveBeenCalled();
	});

	it("an invalid session is refused by every account action", async () => {
		state.sessionError = new Error("session_required");

		for (const call of Object.values(calls)) expect(await call()).toEqual({ error: NOT_ALLOWED });
		for (const query of queries) expect(query).not.toHaveBeenCalled();
	});
});

describe("input validation", () => {
	it.each([undefined, {}, { code: "12345" }, { code: "abcdef" }, { code: "1234567" }])(
		"refuses the phone code %j without calling the query",
		async (values) => {
			expect((await confirmPhoneAction(values)).error).toBeTruthy();
			expect(state.confirmPhone).not.toHaveBeenCalled();
		},
	);

	it.each([undefined, {}, { channel: "sms" }, { channel: "" }])("refuses the channel %j without calling the query", async (values) => {
		expect((await setNotificationChannelAction(values)).error).toBeTruthy();
		expect(state.setChannel).not.toHaveBeenCalled();
	});

	it.each([{}, { termsVersion: 0, privacyVersion: 1 }, { termsVersion: "1", privacyVersion: 1 }])(
		"refuses the legal versions %j without calling the query",
		async (values) => {
			expect((await acceptLegalDocumentsAction(values)).error).toBeTruthy();
			expect(state.acceptLegal).not.toHaveBeenCalled();
		},
	);

	it.each(["+14155552671", "(63) 3222-1234", "(11) 2345-6789"])(
		"refuses the non-mobile number %s without calling the query",
		async (phone) => {
			expect(await requestPhoneVerificationAction({ phone })).toEqual({
				error: "Informe um celular brasileiro com DDD.",
			});
			expect(state.requestPhone).not.toHaveBeenCalled();
		},
	);

	it("refuses an invalid mobile number without calling the query", async () => {
		expect(await requestPhoneVerificationAction({ phone: "6399999123" })).toEqual({
			error: "Celular inválido. Use DDD e número.",
		});
		expect(state.requestPhone).not.toHaveBeenCalled();
	});
});

describe("happy paths", () => {
	it("resends the e-mail with a fresh token and the site url", async () => {
		await expect(calls.resendEmail()).resolves.toEqual(OK);

		expect(state.requestEmail).toHaveBeenCalledWith(
			TX_CLIENT,
			USER_ID,
			expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			"https://app.example.test",
		);
	});

	it("sends a generated code to the query and never returns or logs it", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await calls.requestPhone();

		const [client, userId, phone, code] = state.requestPhone.mock.calls[0];
		expect([client, userId, phone]).toEqual([TX_CLIENT, USER_ID, "+5563999991234"]);
		expect(code).toMatch(/^\d{6}$/);
		expect(result).toEqual(OK);
		expect(JSON.stringify(result)).not.toContain(code);
		expect(JSON.stringify(spy.mock.calls)).not.toContain(code);
		expect(revalidatePath).toHaveBeenCalledWith("/portal/perfil");
		spy.mockRestore();
	});

	it("confirms the phone code and revalidates the profile", async () => {
		await expect(calls.confirmPhone()).resolves.toEqual(OK);

		expect(state.confirmPhone).toHaveBeenCalledWith(TX_CLIENT, USER_ID, "123456");
		expect(revalidatePath).toHaveBeenCalledWith("/portal/perfil");
	});

	it("accepts the legal documents with request meta and revalidates the portal layout", async () => {
		await expect(calls.acceptLegal()).resolves.toEqual(OK);

		expect(state.acceptLegal).toHaveBeenCalledWith(TX_CLIENT, USER_ID, {
			termsVersion: 1,
			privacyVersion: 1,
			ip: "203.0.113.9",
			userAgent: "vitest-agent",
		});
		expect(revalidatePath).toHaveBeenCalledWith("/portal", "layout");
	});

	it("sets the notification channel", async () => {
		await expect(calls.setChannel()).resolves.toEqual(OK);

		expect(state.setChannel).toHaveBeenCalledWith(TX_CLIENT, USER_ID, "whatsapp");
		expect(revalidatePath).toHaveBeenCalledWith("/portal/perfil");
	});
});

describe("reason messages", () => {
	it.each([
		["cooldown", "Aguarde 1 minuto antes de pedir outro envio."],
		["too_many", "Limite de envios atingido. Tente de novo em uma hora."],
		["already_verified", "Seu e-mail já está confirmado."],
		["not_allowed", NOT_ALLOWED],
		["invalid_input", NOT_ALLOWED],
	])("e-mail resend: %s", async (reason, message) => {
		state.requestEmail.mockResolvedValue({ ok: false, reason });
		await expect(calls.resendEmail()).resolves.toEqual({ error: message });
	});

	it.each([
		["cooldown", "Aguarde 1 minuto antes de pedir outro envio."],
		["too_many", "Limite de envios atingido. Tente de novo em uma hora."],
		["already_verified", "Este telefone já está confirmado."],
		["email_not_verified", "Confirme seu e-mail antes de confirmar o telefone."],
		["not_allowed", NOT_ALLOWED],
		["invalid_input", NOT_ALLOWED],
	])("phone request: %s", async (reason, message) => {
		state.requestPhone.mockResolvedValue({ ok: false, reason });
		await expect(calls.requestPhone()).resolves.toEqual({ error: message });
	});

	it.each([
		["invalid", "Código incorreto ou sem pedido ativo. Peça um novo código."],
		["expired", "Código expirado. Peça um novo."],
		["too_many_attempts", "Muitas tentativas. Peça um novo código."],
		["not_allowed", NOT_ALLOWED],
	])("phone confirm: %s", async (reason, message) => {
		state.confirmPhone.mockResolvedValue({ ok: false, reason });
		await expect(calls.confirmPhone()).resolves.toEqual({ error: message });
	});

	it.each([
		["outdated", "Os termos foram atualizados. Recarregue a página."],
		["not_allowed", NOT_ALLOWED],
	])("legal accept: %s", async (reason, message) => {
		state.acceptLegal.mockResolvedValue({ ok: false, reason });
		await expect(calls.acceptLegal()).resolves.toEqual({ error: message });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it.each([
		["phone_not_verified", "Confirme o telefone antes de escolher o WhatsApp."],
		["invalid_input", NOT_ALLOWED],
		["not_allowed", NOT_ALLOWED],
	])("channel: %s", async (reason, message) => {
		state.setChannel.mockResolvedValue({ ok: false, reason });
		await expect(calls.setChannel()).resolves.toEqual({ error: message });
	});

	it("turns an exception into the generic message and logs only name and code", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		state.confirmPhone.mockRejectedValue(Object.assign(new Error("falhou 123456 +5563999991234"), { code: "ECONNRESET" }));

		await expect(calls.confirmPhone()).resolves.toEqual({ error: GENERIC });

		const logged = JSON.stringify(spy.mock.calls);
		expect(logged).toContain("ECONNRESET");
		expect(logged).not.toContain("123456");
		expect(logged).not.toContain("+5563999991234");
		spy.mockRestore();
	});
});
