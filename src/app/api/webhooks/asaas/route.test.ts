import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "w".repeat(32);

const state = vi.hoisted(() => ({
	applyAsaasPayment: vi.fn(),
	readWebhookDatabaseUrl: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
	readAsaasConfig: () => ({ driver: "fake", webhookToken: "w".repeat(32) }),
	readWebhookDatabaseUrl: state.readWebhookDatabaseUrl,
}));
vi.mock("@/lib/wallet/pix-charges", () => ({ applyAsaasPayment: state.applyAsaasPayment }));

import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";

import { POST } from "./route";

const body = {
	id: "evt_1",
	event: "PAYMENT_RECEIVED",
	payment: { object: "payment", id: "pay_1", value: 9999 },
};

function call(payload: unknown, token: string | null = TOKEN) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token !== null) headers.set(ASAAS_WEBHOOK_TOKEN_HEADER, token);
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers,
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.applyAsaasPayment.mockResolvedValue("credited");
	state.readWebhookDatabaseUrl.mockReturnValue("postgres://app_webhook:x@localhost/db");
});

describe("POST /api/webhooks/asaas auth", () => {
	it.each([null, "", "wrong", "w".repeat(31), "w".repeat(33)])("rejects token %j with 401 and writes nothing", async (token) => {
		const response = await call(body, token);

		expect(response.status).toBe(401);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/asaas body", () => {
	it("returns 400 for invalid JSON", async () => {
		const response = await call("{broken");

		expect(response.status).toBe(400);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});

	it.each([
		["no event type", { id: "evt_1", payment: { id: "pay_1" } }],
		["no payment id", { id: "evt_1", event: "PAYMENT_RECEIVED", payment: {} }],
		["no payment", { id: "evt_1", event: "ACCOUNT_STATUS_UPDATED" }],
	])("answers 200, logs one line and writes nothing for valid JSON with %s", async (_name, payload) => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await call(payload);

		expect(response.status).toBe(200);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(log.mock.calls)).not.toContain("pay_1");
		log.mockRestore();
	});
});

describe("POST /api/webhooks/asaas event id", () => {
	it.each(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENT_REFUNDED"])(
		"derives the event id from event and payment id for %s without a top-level id",
		async (event) => {
			const payload = { event, payment: { id: "pay_1" } };

			const response = await call(payload);

			expect(response.status).toBe(200);
			expect(state.applyAsaasPayment).toHaveBeenCalledWith({
				eventId: `${event}:pay_1`,
				eventType: event,
				asaasPaymentId: "pay_1",
				payload,
			});
		},
	);

	it("keeps the top-level id when present", async () => {
		await call(body);

		expect(state.applyAsaasPayment.mock.calls[0][0].eventId).toBe("evt_1");
	});

	it("answers 500 and writes nothing when DATABASE_WEBHOOK_URL is missing", async () => {
		state.readWebhookDatabaseUrl.mockImplementation(() => {
			throw new Error("DATABASE_WEBHOOK_URL is required");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call(body);

		expect(response.status).toBe(500);
		expect(state.applyAsaasPayment).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/asaas result", () => {
	it("forwards event id, type, payment id and the raw payload", async () => {
		const response = await call(body);

		expect(response.status).toBe(200);
		expect(state.applyAsaasPayment).toHaveBeenCalledWith({
			eventId: "evt_1",
			eventType: "PAYMENT_RECEIVED",
			asaasPaymentId: "pay_1",
			payload: body,
		});
	});

	it.each(["credited", "refunded", "duplicate", "ignored", "unknown_charge"])("answers 200 for %s", async (result) => {
		state.applyAsaasPayment.mockResolvedValue(result);

		expect((await call(body)).status).toBe(200);
	});

	it("answers 500 on a database error so Asaas retries", async () => {
		state.applyAsaasPayment.mockRejectedValue(new Error("connection lost"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await call(body);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("connection lost");
	});
});
