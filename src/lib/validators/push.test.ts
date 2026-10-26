import { describe, expect, it } from "vitest";

import { pushEndpointSchema, pushSubscriptionSchema } from "./push";

const valid = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc",
	keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
};

describe("pushSubscriptionSchema", () => {
	it("accepts a PushSubscription.toJSON() payload and drops extra fields", () => {
		const parsed = pushSubscriptionSchema.safeParse({ ...valid, expirationTime: null });
		expect(parsed.success && parsed.data).toEqual(valid);
	});

	it.each([
		["host outside the list", { ...valid, endpoint: "https://evil.com/x" }],
		["short p256dh", { ...valid, keys: { ...valid.keys, p256dh: "B".repeat(79) } }],
		["long auth", { ...valid, keys: { ...valid.keys, auth: "a".repeat(33) } }],
		["auth with a bad character", { ...valid, keys: { ...valid.keys, auth: `${"a".repeat(21)}+` } }],
		["no keys", { endpoint: valid.endpoint }],
	])("refuses %s with a pt-BR message", (_name, input) => {
		const parsed = pushSubscriptionSchema.safeParse(input);
		expect(parsed.success).toBe(false);
		if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/[A-Z].*\./);
	});
});

describe("pushEndpointSchema", () => {
	it("accepts an allowed endpoint and refuses others", () => {
		expect(pushEndpointSchema.safeParse(valid.endpoint).success).toBe(true);
		expect(pushEndpointSchema.safeParse("http://fcm.googleapis.com/x").success).toBe(false);
		expect(pushEndpointSchema.safeParse(42).success).toBe(false);
	});
});
