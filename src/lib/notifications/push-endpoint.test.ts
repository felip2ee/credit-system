import { describe, expect, it } from "vitest";

import { isAllowedPushEndpoint, PUSH_ENDPOINT_MAX_LENGTH } from "./push-endpoint";

describe("isAllowedPushEndpoint", () => {
	it.each([
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/x",
		"https://web.push.apple.com/QH0123",
		"https://wns2-bn3p.notify.windows.com/w/?token=x",
		"https://FCM.GoogleAPIs.com/fcm/send/abc",
	])("accepts %s", (endpoint) => {
		expect(isAllowedPushEndpoint(endpoint)).toBe(true);
	});

	it.each([
		"http://fcm.googleapis.com/x",
		"https://fcm.googleapis.com.evil.com/x",
		"https://evil.com/fcm.googleapis.com",
		"https://fcm.googleapis.com@evil.com/x",
		"https://user:pass@fcm.googleapis.com/x",
		"https://fcm.googleapis.com:8443/x",
		"https://127.0.0.1/x",
		"https://notify.windows.com.evil/x",
		"https://notify.windows.com/x",
		"https://evil.example;.notify.windows.com/x",
		"https://evil!.notify.windows.com/x",
		"https://evil*.notify.windows.com/x",
		"https://wns2.notify.windows.com\\@evil.com/x",
		"https://evil.example\\.notify.windows.com/x",
		"https://fcm.googleapis.com%2e.evil.com/x",
		"https://evil.com%2f.notify.windows.com/x",
		"https://fcm_googleapis.com/x",
		"not a url",
		"",
	])("refuses %s", (endpoint) => {
		expect(isAllowedPushEndpoint(endpoint)).toBe(false);
	});

	it("refuses text longer than the limit", () => {
		const prefix = "https://fcm.googleapis.com/";
		expect(isAllowedPushEndpoint(prefix + "a".repeat(PUSH_ENDPOINT_MAX_LENGTH - prefix.length))).toBe(true);
		expect(isAllowedPushEndpoint(prefix + "a".repeat(PUSH_ENDPOINT_MAX_LENGTH + 1 - prefix.length))).toBe(false);
	});
});
