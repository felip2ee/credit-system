import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s".repeat(32);
const VERIFY = "v".repeat(32);
const PHONE_ID = "1234567890";

const state = vi.hoisted(() => ({
	query: vi.fn(),
	readWhatsappConfig: vi.fn(),
	readWebhookDatabaseUrl: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
	readWhatsappConfig: state.readWhatsappConfig,
	readWebhookDatabaseUrl: state.readWebhookDatabaseUrl,
}));
vi.mock("@/lib/db/webhook-pool", () => ({
	getWebhookPool: () => ({ query: state.query }),
}));

import { GET, POST } from "./route";

const sign = (body: string | Buffer, secret = SECRET) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function post(body: string | Buffer, signature: string | null = sign(body)) {
	const headers = new Headers({ "content-type": "application/json" });
	if (signature !== null) headers.set("x-hub-signature-256", signature);
	return POST(
		new Request("http://localhost/api/webhooks/whatsapp", {
			method: "POST",
			headers,
			body: typeof body === "string" ? body : new Uint8Array(body),
		}),
	);
}

const payload = (value: Record<string, unknown>, phoneNumberId = PHONE_ID) =>
	JSON.stringify({
		object: "whatsapp_business_account",
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: { metadata: { phone_number_id: phoneNumberId }, ...value },
					},
				],
			},
		],
	});

const statusBody = payload({
	statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1700000000" }],
});

function get(params: Record<string, string>) {
	return GET(
		new Request(
			`http://localhost/api/webhooks/whatsapp?${new URLSearchParams(params)}`,
		),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.readWhatsappConfig.mockReturnValue({
		driver: "fake",
		phoneNumberId: PHONE_ID,
		appSecret: SECRET,
		verifyToken: VERIFY,
	});
	state.readWebhookDatabaseUrl.mockReturnValue(
		"postgres://app_webhook:x@localhost/db",
	);
	state.query.mockResolvedValue({ rows: [{ result: "applied" }] });
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/webhooks/whatsapp", () => {
	it("returns the challenge as text/plain for the right token", async () => {
		const response = await get({
			"hub.mode": "subscribe",
			"hub.verify_token": VERIFY,
			"hub.challenge": "158772",
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(await response.text()).toBe("158772");
	});

	it.each([
		[
			"wrong token",
			{
				"hub.mode": "subscribe",
				"hub.verify_token": "nope",
				"hub.challenge": "1",
			},
		],
		[
			"wrong mode",
			{
				"hub.mode": "unsubscribe",
				"hub.verify_token": VERIFY,
				"hub.challenge": "1",
			},
		],
		[
			"challenge with letters",
			{
				"hub.mode": "subscribe",
				"hub.verify_token": VERIFY,
				"hub.challenge": "12a",
			},
		],
		[
			"challenge over 64 digits",
			{
				"hub.mode": "subscribe",
				"hub.verify_token": VERIFY,
				"hub.challenge": "1".repeat(65),
			},
		],
		["no params", {}],
	])("returns 403 for %s", async (_name, params) => {
		expect((await get(params)).status).toBe(403);
	});

	it("returns 404 when WhatsApp is turned off", async () => {
		state.readWhatsappConfig.mockReturnValue(null);

		expect(
			(
				await get({
					"hub.mode": "subscribe",
					"hub.verify_token": VERIFY,
					"hub.challenge": "1",
				})
			).status,
		).toBe(404);
	});

	it("returns 500 when the WhatsApp configuration is invalid", async () => {
		state.readWhatsappConfig.mockImplementation(() => {
			throw new Error("WHATSAPP_APP_SECRET must be at least 32 characters");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(
			(
				await get({
					"hub.mode": "subscribe",
					"hub.verify_token": VERIFY,
					"hub.challenge": "1",
				})
			).status,
		).toBe(500);
	});
});

describe("POST /api/webhooks/whatsapp signature", () => {
	it.each([
		["no header", null],
		[
			"no sha256= prefix",
			createHmac("sha256", SECRET).update(statusBody).digest("hex"),
		],
		["short hex", "sha256=abcd"],
		["other secret", sign(statusBody, "x".repeat(32))],
	])("rejects %s with 401 and no database call", async (_name, signature) => {
		const response = await post(statusBody, signature);

		expect(response.status).toBe(401);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("rejects a body altered by one byte", async () => {
		const response = await post(
			statusBody.replace("wamid.1", "wamid.2"),
			sign(statusBody),
		);

		expect(response.status).toBe(401);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("accepts a signature over the raw bytes of a body with an escaped accent", async () => {
		// JSON.stringify deixa o "á" cru; o replace o escapa, e a assinatura cobre os bytes com a barra.
		const body = payload({
			statuses: [{ id: "wamid.á", status: "sent", timestamp: "1700000000" }],
		}).replace("á", "\\u00e1");

		expect(body).toContain("\\u00e1");
		expect((await post(Buffer.from(body))).status).toBe(200);
		expect(state.query.mock.calls[0][1][0]).toBe("wamid.á");
	});

	it("returns 413 above 262144 bytes, before the signature check", async () => {
		const big = Buffer.alloc(262_145, "a");

		expect((await post(big, sign(big))).status).toBe(413);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("returns 413 on a content-length above the limit, without waiting for the body", async () => {
		const body = new ReadableStream<Uint8Array>({ pull: () => {} });
		const request = new Request("http://localhost/api/webhooks/whatsapp", {
			method: "POST",
			headers: { "content-length": "262145" },
			body,
			duplex: "half",
		} as RequestInit);

		expect((await POST(request)).status).toBe(413);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("aborts a streamed body that passes the limit without a content-length", async () => {
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += 65_536;
				controller.enqueue(new Uint8Array(65_536));
			},
		});
		const request = new Request("http://localhost/api/webhooks/whatsapp", {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);

		expect((await POST(request)).status).toBe(413);
		expect(sent).toBeLessThan(262_144 + 4 * 65_536);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("returns 400 for broken JSON with a valid signature", async () => {
		expect((await post("{broken")).status).toBe(400);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("returns 404 when WhatsApp is turned off", async () => {
		state.readWhatsappConfig.mockReturnValue(null);

		expect((await post(statusBody)).status).toBe(404);
	});

	it("returns 500 when the app secret is missing", async () => {
		state.readWhatsappConfig.mockImplementation(() => {
			throw new Error("WHATSAPP_APP_SECRET is required");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await post(statusBody)).status).toBe(500);
	});

	it("answers 401 to a bad signature and 500 only to a good one when the database is not configured", async () => {
		state.readWebhookDatabaseUrl.mockImplementation(() => {
			throw new Error("DATABASE_WEBHOOK_URL is required");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await post(statusBody, "sha256=abcd")).status).toBe(401);
		expect((await post(statusBody)).status).toBe(500);
		expect(state.query).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/whatsapp events", () => {
	it("duplicate status delivery changes nothing", async () => {
		const info = vi.spyOn(console, "warn").mockImplementation(() => {});
		state.query
			.mockResolvedValueOnce({ rows: [{ result: "applied" }] })
			.mockResolvedValueOnce({ rows: [{ result: "duplicate" }] });

		expect((await post(statusBody)).status).toBe(200);
		expect((await post(statusBody)).status).toBe(200);

		expect(info.mock.calls[0][1]).toMatchObject({ applied: 1, duplicate: 0 });
		expect(info.mock.calls[1][1]).toMatchObject({ applied: 0, duplicate: 1 });
	});

	it("ignores a phone_number_id of another number", async () => {
		const body = payload(
			{ statuses: [{ id: "wamid.1", status: "sent", timestamp: "1" }] },
			"999",
		);

		expect((await post(body)).status).toBe(200);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("opt-out matches wa_id without the ninth digit", async () => {
		const body = payload({
			messages: [
				{ from: "556392345615", type: "text", text: { body: " Parar " } },
			],
		});

		expect((await post(body)).status).toBe(200);
		expect(state.query.mock.calls.map((call) => call[1])).toEqual([
			["+556392345615"],
			["+5563992345615"],
		]);
	});

	it("does not record an opt-out for a keyword inside a sentence", async () => {
		const body = payload({
			messages: [
				{
					from: "556392345615",
					type: "text",
					text: { body: "quero parar agora" },
				},
			],
		});

		expect((await post(body)).status).toBe(200);
		expect(state.query).not.toHaveBeenCalled();
	});

	it("returns 200 when nothing applies", async () => {
		expect((await post(payload({}))).status).toBe(200);
		expect(state.query).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/whatsapp failures and logs", () => {
	it("returns 500 on a database error so Meta retries", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		state.query.mockRejectedValue(new Error("connection refused"));

		expect((await post(statusBody)).status).toBe(500);
	});

	it("never logs the body, sender, text or signature", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((m) =>
			vi.spyOn(console, m).mockImplementation(() => {}),
		);
		const body = payload({
			statuses: [{ id: "wamid.secret", status: "sent", timestamp: "1" }],
			messages: [
				{ from: "556392345615", type: "text", text: { body: "PARAR" } },
			],
		});
		const signature = sign(body);
		await post(body, signature);
		state.query.mockRejectedValue(new Error("boom 556392345615 wamid.secret"));
		await post(body, signature);

		const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		for (const secret of [
			"556392345615",
			"wamid.secret",
			"PARAR",
			signature,
			"boom",
		]) {
			expect(logged).not.toContain(secret);
		}
	});
});
