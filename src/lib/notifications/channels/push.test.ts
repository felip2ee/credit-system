import { createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";

import { generateVAPIDKeys } from "web-push";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({ readPushConfig: vi.fn() }));
vi.mock("@/lib/config", () => configMock);
vi.mock("@/lib/db/dispatch-pool", () => ({ getDispatchPool: () => ({ query: vi.fn() }) }));

import type { ClaimedNotification } from "../types";
import { sendPushNotification } from "./push";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const notification: ClaimedNotification = {
	id: "0b8f6f0e-1111-2222-3333-444455556666",
	lease_id: "l-1",
	channel: "push",
	recipient: "sub-1",
	params: { url: "/portal/afiliacao" },
	attempts: 1,
	opted_out: false,
	template_key: "commission_received",
	template_version: 1,
	template_params: ["url"],
	email_subject: null,
	email_html: null,
	email_text: null,
	wa_template_name: null,
	wa_language: null,
};

const send = vi.fn();
const query = vi.fn();
const deps = { send, query };

function lookupReturns(endpoint: string | null) {
	query.mockImplementation(async (sql: string) => {
		if (sql.includes("push_subscription_for_delivery")) {
			return { rows: endpoint ? [{ endpoint, p256dh: "p256dh-key", auth: "auth-key" }] : [] };
		}
		return { rows: [{ delete_gone_push_subscription: true }] };
	});
}
const deleteCalls = () => query.mock.calls.filter(([sql]) => String(sql).includes("delete_gone_push_subscription"));

beforeEach(() => {
	send.mockReset().mockResolvedValue({ statusCode: 201 });
	query.mockReset();
	lookupReturns(ENDPOINT);
	configMock.readPushConfig.mockReset().mockReturnValue({
		publicKey: "A".repeat(87),
		privateKey: "B".repeat(43),
		subject: "mailto:ops@example.test",
	});
});

describe("sendPushNotification", () => {
	it("empty VAPID config is channel_not_configured and nothing is sent", async () => {
		configMock.readPushConfig.mockReturnValue(null);

		expect(await sendPushNotification(notification, deps)).toEqual({
			ok: false,
			permanent: true,
			code: "channel_not_configured",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("an invalid VAPID config is a transient config_error", async () => {
		configMock.readPushConfig.mockImplementation(() => {
			throw new Error("WEB_PUSH_VAPID_PRIVATE_KEY is required");
		});

		expect(await sendPushNotification(notification, deps)).toEqual({ ok: false, permanent: false, code: "config_error" });
		expect(send).not.toHaveBeenCalled();
	});

	it("an unknown template is a permanent template_render_error before any lookup", async () => {
		expect(await sendPushNotification({ ...notification, template_key: "platform_test" }, deps)).toEqual({
			ok: false,
			permanent: true,
			code: "template_render_error",
		});
		expect(query).not.toHaveBeenCalled();
	});

	it("no subscription row is subscription_gone and nothing is sent", async () => {
		lookupReturns(null);

		expect(await sendPushNotification(notification, deps)).toEqual({ ok: false, permanent: true, code: "subscription_gone" });
		expect(send).not.toHaveBeenCalled();
		expect(query.mock.calls[0][1]).toEqual([notification.id, notification.lease_id]);
	});

	it.each([
		"http://fcm.googleapis.com/fcm/send/abc",
		"https://127.0.0.1/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://fcm.googleapis.com.evil.example/fcm/send/abc",
		"https://evil.example/fcm.googleapis.com",
		"https://user:pw@fcm.googleapis.com/fcm/send/abc",
	])("endpoint not allowlisted is not sent: %s", async (endpoint) => {
		lookupReturns(endpoint);

		expect(await sendPushNotification(notification, deps)).toEqual({ ok: false, permanent: true, code: "invalid_endpoint" });
		expect(send).not.toHaveBeenCalled();
	});

	it("sends endpoint, keys, JSON payload and TTL, then returns push:<id>", async () => {
		const result = await sendPushNotification(notification, deps);

		expect(result).toEqual({ ok: true, providerMessageId: `push:${notification.id}` });
		const [subscription, payload, options] = send.mock.calls[0];
		expect(subscription).toEqual({ endpoint: ENDPOINT, keys: { p256dh: "p256dh-key", auth: "auth-key" } });
		expect(JSON.parse(payload)).toEqual({
			title: "Rainha Cred",
			body: "Você recebeu uma comissão",
			url: "/portal/afiliacao",
		});
		expect(options).toMatchObject({
			TTL: 86400,
			urgency: "normal",
			timeout: 10000,
			vapidDetails: { subject: "mailto:ops@example.test", publicKey: "A".repeat(87), privateKey: "B".repeat(43) },
		});
		expect(deleteCalls()).toHaveLength(0);
	});

	it("410 deletes the subscription with the lease and fails permanently as push_gone", async () => {
		send.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

		expect(await sendPushNotification(notification, deps)).toEqual({ ok: false, permanent: true, code: "push_gone" });
		expect(deleteCalls()).toHaveLength(1);
		expect(deleteCalls()[0][1]).toEqual([notification.id, notification.lease_id]);
	});

	it("503 is transient and keeps the subscription", async () => {
		send.mockRejectedValue(Object.assign(new Error("down"), { statusCode: 503 }));

		expect(await sendPushNotification(notification, deps)).toEqual({
			ok: false,
			permanent: false,
			code: "provider_unavailable",
		});
		expect(deleteCalls()).toHaveLength(0);
	});

	it("a redirect answer is rejected, not followed: one send only", async () => {
		send.mockRejectedValue(Object.assign(new Error("moved"), { statusCode: 302 }));

		expect(await sendPushNotification(notification, deps)).toEqual({
			ok: false,
			permanent: true,
			code: "provider_rejected",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("never logs the endpoint", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		send.mockRejectedValue(Object.assign(new Error(`failed for ${ENDPOINT}`), { statusCode: 410 }));

		await sendPushNotification(notification, deps);

		expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls, ...error.mock.calls, ...log.mock.calls])).not.toContain(ENDPOINT);
	});
});

// web-push real, https.request simulado: o serviço de push responde 302 para um host interno.
describe("sendPushNotification with the real web-push", () => {
	it("does not follow a redirect: one request, permanent provider_rejected", async () => {
		const vapid = generateVAPIDKeys();
		configMock.readPushConfig.mockReturnValue({ ...vapid, subject: "mailto:ops@example.test" });
		const browser = createECDH("prime256v1");
		browser.generateKeys();
		query.mockImplementation(async (sql: string) => ({
			rows: sql.includes("push_subscription_for_delivery")
				? [
						{
							endpoint: ENDPOINT,
							p256dh: browser.getPublicKey().toString("base64url"),
							auth: randomBytes(16).toString("base64url"),
						},
					]
				: [],
		}));
		const requested: string[] = [];
		vi.spyOn(https, "request").mockImplementation(((options: { hostname: string; path: string }, callback: (res: EventEmitter) => void) => {
			requested.push(`${options.hostname}${options.path}`);
			const request = Object.assign(new EventEmitter(), {
				write: () => true,
				end: () => {
					const response = Object.assign(new EventEmitter(), {
						statusCode: 302,
						headers: { location: "https://169.254.169.254/latest/meta-data" },
					});
					callback(response);
					response.emit("end");
				},
				setTimeout: () => request,
				destroy: () => request,
			});
			return request;
		}) as unknown as typeof https.request);

		const result = await sendPushNotification(notification, { query });

		expect(result).toEqual({ ok: false, permanent: true, code: "provider_rejected" });
		expect(requested).toEqual(["fcm.googleapis.com/fcm/send/abc123"]);
		vi.restoreAllMocks();
	});
});
