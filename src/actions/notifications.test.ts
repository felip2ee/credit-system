import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	session: vi.fn(),
	retry: vi.fn(),
	enqueue: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/db/transaction", () => ({
	platformIdentity: (i: { userId: string; role: string }) => ({ userId: i.userId, role: i.role, bureauId: null }),
	withUserTransaction: s.transaction,
}));
vi.mock("@/lib/notifications/queries", () => ({ retryNotification: s.retry, enqueueNotification: s.enqueue }));

import { retryNotificationAction, sendTestNotificationAction } from "./notifications";

const superadmin = { userId: randomUUID(), role: "superadmin", bureauId: null, supportSessionId: null, support: null };
const id = randomUUID();
const client = { query: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	s.session.mockResolvedValue(superadmin);
	s.retry.mockResolvedValue({ ok: true });
	s.enqueue.mockResolvedValue({ ok: true, id, duplicate: false });
	s.transaction.mockImplementation((_identity, work) => work(client));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe.each([
	["retryNotificationAction", () => retryNotificationAction({ id }), s.retry],
	["sendTestNotificationAction", () => sendTestNotificationAction({ channel: "email", recipient: "a@b.com" }), s.enqueue],
])("%s authorization", (_name, run, write) => {
	it.each(["bureau_admin", "operator", "client"])("refuses the %s", async (role) => {
		s.session.mockResolvedValue({ ...superadmin, role });

		expect((await run()).error).toMatch(/permissão/);
		expect(write).not.toHaveBeenCalled();
	});

	it("refuses a superadmin in a support session", async () => {
		s.session.mockResolvedValue({ ...superadmin, supportSessionId: randomUUID() });

		expect((await run()).error).toMatch(/suporte/);
		expect(write).not.toHaveBeenCalled();
	});

	it("hides a thrown error", async () => {
		write.mockRejectedValue(new Error("secret db detail"));

		const result = await run();

		expect(result.error).toBeTruthy();
		expect(result.error).not.toMatch(/secret/);
	});
});

describe("retryNotificationAction", () => {
	it("retries the notification", async () => {
		expect(await retryNotificationAction({ id })).toEqual({ error: null, id });
		expect(s.retry).toHaveBeenCalledWith(superadmin, id);
	});

	it("rejects an invalid id before any session or write", async () => {
		expect((await retryNotificationAction({ id: "x" })).error).toBeTruthy();
		expect(s.session).not.toHaveBeenCalled();
		expect(s.retry).not.toHaveBeenCalled();
	});

	it("explains a purged payload", async () => {
		s.retry.mockResolvedValue({ ok: false, reason: "payload_purged" });

		expect((await retryNotificationAction({ id })).error).toMatch(/apagados/);
	});

	it("maps a missing failure reason to a generic error, never undefined", async () => {
		s.retry.mockResolvedValue({ ok: false, reason: undefined });

		expect((await retryNotificationAction({ id })).error).toBe("Não foi possível concluir a operação.");
	});
});

describe("sendTestNotificationAction", () => {
	it("enqueues a platform test without a Bureau and a fresh idempotency key", async () => {
		const first = await sendTestNotificationAction({ channel: "whatsapp", recipient: "11987654321" });
		await sendTestNotificationAction({ channel: "whatsapp", recipient: "11987654321" });

		expect(first).toEqual({ error: null, id });
		expect(s.transaction.mock.calls[0][0]).toEqual({ userId: superadmin.userId, role: "superadmin", bureauId: null });
		const [passedClient, , input] = s.enqueue.mock.calls[0];
		expect(passedClient).toBe(client);
		expect(input).toMatchObject({
			templateKey: "platform_test",
			channel: "whatsapp",
			recipient: "11987654321",
			params: {},
		});
		expect(input.idempotencyKey).toMatch(/^test:[0-9a-f-]{36}$/);
		expect(s.enqueue.mock.calls[1][2].idempotencyKey).not.toBe(input.idempotencyKey);
	});

	it.each([
		[{ channel: "sms", recipient: "a@b.com" }],
		[{ channel: "email", recipient: "" }],
		[{ recipient: "a@b.com" }],
	])("rejects invalid input %j before any session", async (values) => {
		expect((await sendTestNotificationAction(values)).error).toBeTruthy();
		expect(s.session).not.toHaveBeenCalled();
	});

	it("explains an invalid recipient", async () => {
		s.enqueue.mockResolvedValue({ ok: false, reason: "invalid_recipient" });

		expect((await sendTestNotificationAction({ channel: "email", recipient: "nope" })).error).toMatch(/Destinatário inválido/);
	});
});
