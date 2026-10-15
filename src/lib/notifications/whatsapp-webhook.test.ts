import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({}));

import {
	applyWhatsappWebhook,
	isOptOutKeyword,
	parseWhatsappWebhook,
	signatureMatches,
	verifyTokenMatches,
} from "./whatsapp-webhook";

const SECRET = "s".repeat(32);
const PHONE_ID = "1234567890";

const sign = (body: Buffer, secret = SECRET) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const envelope = (
	value: Record<string, unknown>,
	phoneNumberId = PHONE_ID,
) => ({
	object: "whatsapp_business_account",
	entry: [
		{
			id: "waba",
			changes: [
				{
					field: "messages",
					value: { metadata: { phone_number_id: phoneNumberId }, ...value },
				},
			],
		},
	],
});

describe("signatureMatches", () => {
	const body = Buffer.from('{"a":"\\u00e1"}');

	it("accepts a signature over the raw bytes, including an escaped accent", () => {
		expect(signatureMatches(body, sign(body), SECRET)).toBe(true);
	});

	it.each([
		["missing header", null],
		[
			"no sha256= prefix",
			createHmac("sha256", SECRET)
				.update(Buffer.from('{"a":"\\u00e1"}'))
				.digest("hex"),
		],
		["short hex", "sha256=abcd"],
		["non-hex", `sha256=${"z".repeat(64)}`],
		["other secret", sign(body, "x".repeat(32))],
	])("rejects %s", (_name, header) => {
		expect(signatureMatches(body, header, SECRET)).toBe(false);
	});

	it("rejects a body altered by one byte", () => {
		const tampered = Buffer.from('{"a":"\\u00e2"}');

		expect(signatureMatches(tampered, sign(body), SECRET)).toBe(false);
	});
});

describe("verifyTokenMatches", () => {
	it("compares tokens of different length without throwing", () => {
		expect(verifyTokenMatches("abc", "abcdef")).toBe(false);
		expect(verifyTokenMatches(null, "abcdef")).toBe(false);
		expect(verifyTokenMatches("abcdef", "abcdef")).toBe(true);
	});
});

describe("isOptOutKeyword", () => {
	it.each([
		"PARAR",
		" parar ",
		"Sair",
		"stop",
		"Cancelar",
		"descadastrar",
		"parár",
	])("accepts %j", (text) => {
		expect(isOptOutKeyword(text)).toBe(true);
	});

	it.each(["quero parar agora", "", "parar!", "paraar"])(
		"rejects %j",
		(text) => {
			expect(isOptOutKeyword(text)).toBe(false);
		},
	);
});

describe("parseWhatsappWebhook", () => {
	it("extracts statuses and opt-out senders for the configured number", () => {
		const parsed = parseWhatsappWebhook(
			envelope({
				statuses: [
					{
						id: "wamid.1",
						status: "failed",
						timestamp: "1700000000",
						errors: [{ code: 131026 }],
					},
				],
				messages: [
					{ from: "556392345615", type: "text", text: { body: "Parar" } },
				],
			}),
			PHONE_ID,
		);

		expect(parsed.statuses).toEqual([
			{
				providerMessageId: "wamid.1",
				status: "failed",
				errorCode: "131026",
				occurredAt: new Date(1_700_000_000_000),
			},
		]);
		expect(parsed.optOutSenders).toEqual(["556392345615"]);
	});

	it("ignores another phone_number_id, malformed items and non-text messages", () => {
		const other = parseWhatsappWebhook(
			envelope(
				{ statuses: [{ id: "w", status: "sent", timestamp: "1" }] },
				"999",
			),
			PHONE_ID,
		);
		const malformed = parseWhatsappWebhook(
			envelope({
				statuses: [
					{ id: "w", status: "deleted", timestamp: "1" },
					"x",
					{ id: "ok", status: "sent", timestamp: 5 },
				],
				messages: [
					{ from: "5563", type: "text", text: { body: "PARAR" } },
					{ from: "556392345615", type: "image" },
				],
			}),
			PHONE_ID,
		);

		expect(other).toEqual({ statuses: [], optOutSenders: [] });
		expect(malformed.statuses.map((s) => s.providerMessageId)).toEqual(["ok"]);
		expect(malformed.optOutSenders).toEqual([]);
	});

	it("drops a status whose timestamp would make an invalid Date", () => {
		const parsed = parseWhatsappWebhook(
			envelope({
				statuses: [
					{ id: "huge", status: "sent", timestamp: "99999999999999" },
					{ id: "ok", status: "sent", timestamp: "1700000000" },
				],
			}),
			PHONE_ID,
		);

		expect(parsed.statuses.map((s) => s.providerMessageId)).toEqual(["ok"]);
		expect(Number.isNaN(parsed.statuses[0].occurredAt.getTime())).toBe(false);
	});

	it("returns nothing for a foreign object", () => {
		expect(
			parseWhatsappWebhook({ object: "page", entry: [] }, PHONE_ID),
		).toEqual({ statuses: [], optOutSenders: [] });
	});
});

describe("applyWhatsappWebhook", () => {
	it("opt-out matches wa_id without the ninth digit", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [] });

		const counts = await applyWhatsappWebhook(
			{ statuses: [], optOutSenders: ["556392345615"] },
			{ query },
		);

		expect(query.mock.calls.map((call) => call[1])).toEqual([
			["+556392345615"],
			["+5563992345615"],
		]);
		expect(counts.optOut).toBe(1);
	});

	it("counts each status result", async () => {
		const results = ["applied", "duplicate", "orphan", "ignored"];
		const query = vi
			.fn()
			.mockImplementation(async () => ({
				rows: [{ result: results.shift() }],
			}));
		const at = new Date(0);
		const statuses = results.map((_r, i) => ({
			providerMessageId: `w${i}`,
			status: "sent" as const,
			errorCode: null,
			occurredAt: at,
		}));

		const counts = await applyWhatsappWebhook(
			{ statuses, optOutSenders: [] },
			{ query },
		);

		expect(counts).toEqual({
			applied: 1,
			duplicate: 1,
			orphan: 1,
			ignored: 1,
			optOut: 0,
		});
	});
});
