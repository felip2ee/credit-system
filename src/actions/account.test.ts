import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const TX_CLIENT = { tx: true };

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	requestPhone: vi.fn(),
	confirmPhone: vi.fn(),
	acceptLegal: vi.fn(),
	setChannel: vi.fn(),
	pushRegister: vi.fn(),
	pushRemove: vi.fn(),
	pushActive: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://app.example.test" } }));
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "vitest-agent" }),
}));
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
	requestPhoneVerification: state.requestPhone,
	confirmPhoneVerification: state.confirmPhone,
	acceptLegalDocuments: state.acceptLegal,
	setNotificationChannel: state.setChannel,
}));

vi.mock("@/lib/notifications/push-subscriptions", () => ({
	registerPushSubscription: state.pushRegister,
	removePushSubscription: state.pushRemove,
	isPushSubscriptionActive: state.pushActive,
}));

import { revalidatePath } from "next/cache";

import {
	acceptLegalDocumentsAction,
	confirmPhoneAction,
	getPushSubscriptionStatusAction,
	registerPushSubscriptionAction,
	removePushSubscriptionAction,
	requestPhoneVerificationAction,
	setNotificationChannelAction,
} from "./account";

const NOT_ALLOWED = "Ação não permitida.";
const GENERIC = "Não foi possível concluir. Tente novamente.";
const OK = { error: null };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	for (const fn of [state.requestPhone, state.confirmPhone, state.acceptLegal, state.setChannel]) {
		fn.mockResolvedValue({ ok: true });
	}
	state.pushRegister.mockResolvedValue({ ok: true });
	state.pushRemove.mockResolvedValue({ ok: true });
	state.pushActive.mockResolvedValue(true);
});

const calls = {
	requestPhone: () => requestPhoneVerificationAction({ phone: "(63) 99999-1234" }),
	confirmPhone: () => confirmPhoneAction({ code: "123456" }),
	acceptLegal: () => acceptLegalDocumentsAction({ termsVersion: 1, privacyVersion: 1 }),
	setChannel: () => setNotificationChannelAction({ channel: "whatsapp" }),
};
const queries = [state.requestPhone, state.confirmPhone, state.acceptLegal, state.setChannel];

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
		["already_verified", "Este telefone já está confirmado."],
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

describe("push subscription actions", () => {
	const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
	const subscription = { endpoint: ENDPOINT, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
	const actions = {
		register: { call: () => registerPushSubscriptionAction(subscription), query: state.pushRegister },
		remove: { call: () => removePushSubscriptionAction({ endpoint: ENDPOINT }), query: state.pushRemove },
	};

	it("registers with the keys and the request user agent, then revalidates", async () => {
		expect(await registerPushSubscriptionAction({ ...subscription, expirationTime: null })).toEqual(OK);

		expect(state.pushRegister).toHaveBeenCalledWith(TX_CLIENT, {
			endpoint: ENDPOINT,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
			userAgent: "vitest-agent",
		});
		expect(revalidatePath).toHaveBeenCalledWith("/portal/notificacoes");
	});

	it("removes the endpoint, then revalidates", async () => {
		expect(await removePushSubscriptionAction({ endpoint: ENDPOINT })).toEqual(OK);

		expect(state.pushRemove).toHaveBeenCalledWith(TX_CLIENT, ENDPOINT);
		expect(revalidatePath).toHaveBeenCalledWith("/portal/notificacoes");
	});

	it.each(Object.keys(actions) as (keyof typeof actions)[])("%s refuses an operator without a query", async (name) => {
		state.role = "operator";

		expect(await actions[name].call()).toEqual({ error: NOT_ALLOWED });
		expect(actions[name].query).not.toHaveBeenCalled();
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it.each([undefined, {}, { endpoint: "https://evil.com/x" }, { endpoint: "http://fcm.googleapis.com/x" }])(
		"refuses the invalid input %j without a query",
		async (values) => {
			expect((await registerPushSubscriptionAction(values)).error).toBeTruthy();
			expect((await removePushSubscriptionAction(values)).error).toBeTruthy();
			expect(state.pushRegister).not.toHaveBeenCalled();
			expect(state.pushRemove).not.toHaveBeenCalled();
		},
	);

	it.each(Object.keys(actions) as (keyof typeof actions)[])("%s maps a SQL not_allowed to the pt-BR message", async (name) => {
		actions[name].query.mockResolvedValue({ ok: false, reason: "not_allowed" });

		expect(await actions[name].call()).toEqual({ error: NOT_ALLOWED });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("maps a SQL invalid_input on register to the pt-BR message", async () => {
		state.pushRegister.mockResolvedValue({ ok: false, reason: "invalid_input" });

		expect(await actions.register.call()).toEqual({ error: NOT_ALLOWED });
	});

	it.each(Object.keys(actions) as (keyof typeof actions)[])("%s hides a thrown error behind the generic message", async (name) => {
		actions[name].query.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(await actions[name].call()).toEqual({ error: GENERIC });
	});

	describe("getPushSubscriptionStatusAction", () => {
		it("returns the SQL answer", async () => {
			expect(await getPushSubscriptionStatusAction({ endpoint: ENDPOINT })).toEqual({ error: null, subscribed: true });
			expect(state.pushActive).toHaveBeenCalledWith(TX_CLIENT, ENDPOINT);

			state.pushActive.mockResolvedValue(false);
			expect(await getPushSubscriptionStatusAction({ endpoint: ENDPOINT })).toEqual({ error: null, subscribed: false });
		});

		it.each([undefined, {}, { endpoint: "https://evil.com/x" }])("answers not subscribed for %j without a query", async (values) => {
			expect(await getPushSubscriptionStatusAction(values)).toEqual({ error: null, subscribed: false });
			expect(state.pushActive).not.toHaveBeenCalled();
		});

		it("refuses an operator without a query", async () => {
			state.role = "operator";

			expect(await getPushSubscriptionStatusAction({ endpoint: ENDPOINT })).toEqual({ error: NOT_ALLOWED, subscribed: false });
			expect(state.pushActive).not.toHaveBeenCalled();
		});

		it("hides a thrown error behind the generic message", async () => {
			state.pushActive.mockRejectedValue(new Error("db down"));
			vi.spyOn(console, "error").mockImplementation(() => undefined);

			expect(await getPushSubscriptionStatusAction({ endpoint: ENDPOINT })).toEqual({ error: GENERIC, subscribed: false });
		});
	});
});
