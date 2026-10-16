import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({ readWhatsappConfig: vi.fn() }));
vi.mock("@/lib/config", () => configMock);

import type { ClaimedNotification } from "../types";
import { sendWhatsappNotification } from "./whatsapp";

const TOKEN = "EAAG-super-secret-access-token";
const metaConfig = {
	driver: "meta",
	accessToken: TOKEN,
	phoneNumberId: "111222333",
	appSecret: "a".repeat(32),
	verifyToken: "v".repeat(32),
	graphBaseUrl: "https://graph.example.test",
	graphVersion: "v21.0",
};

const notification: ClaimedNotification = {
	id: "n-1",
	lease_id: "l-1",
	channel: "whatsapp",
	recipient: "+5563992345615",
	params: { code: "123456" },
	attempts: 1,
	opted_out: false,
	template_key: "scr_code",
	template_version: 1,
	template_params: ["code"],
	email_subject: null,
	email_html: null,
	email_text: null,
	wa_template_name: "scr_code",
	wa_language: "pt_BR",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	configMock.readWhatsappConfig.mockReset().mockReturnValue(metaConfig);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("sendWhatsappNotification", () => {
	it("posts the template to the Graph API and returns the message id", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.ABC" }] }));
		const result = await sendWhatsappNotification(notification);

		expect(result).toEqual({ ok: true, providerMessageId: "wamid.ABC" });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://graph.example.test/v21.0/111222333/messages");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(init.body)).toMatchObject({ to: "5563992345615", type: "template" });
	});

	it("fake driver returns a fake wamid without calling fetch", async () => {
		configMock.readWhatsappConfig.mockReturnValue({ ...metaConfig, driver: "fake" });
		const result = await sendWhatsappNotification(notification);
		expect(result).toMatchObject({ ok: true });
		expect(result.ok && result.providerMessageId).toMatch(/^fake-wamid-[0-9a-f-]{36}$/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fake driver logs template, masked recipient and params outside production", async () => {
		configMock.readWhatsappConfig.mockReturnValue({ ...metaConfig, driver: "fake" });
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		await sendWhatsappNotification(notification);
		expect(info).toHaveBeenCalledWith("[whatsapp:fake]", {
			template: "scr_code",
			to: "+55*******5615",
			params: { code: "123456" },
		});
		expect(JSON.stringify(info.mock.calls)).not.toContain("5563992345615");
	});

	it("fake driver never logs in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		// Em produção readWhatsappConfig recusa o driver fake e devolve null.
		configMock.readWhatsappConfig.mockReturnValue(null);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: true,
			code: "channel_not_configured",
		});
		expect(info).not.toHaveBeenCalled();
	});

	it("is permanent channel_not_configured without configuration", async () => {
		configMock.readWhatsappConfig.mockReturnValue(null);
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: true,
			code: "channel_not_configured",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is transient config_error when the configuration is invalid", async () => {
		configMock.readWhatsappConfig.mockImplementation(() => {
			throw new Error("WHATSAPP_APP_SECRET must be at least 32 characters");
		});
		expect(await sendWhatsappNotification(notification)).toEqual({ ok: false, permanent: false, code: "config_error" });
	});

	it("refuses an invalid parameter value without calling fetch", async () => {
		const result = await sendWhatsappNotification({ ...notification, params: { code: "a\nb" } });
		expect(result).toEqual({ ok: false, permanent: true, code: "invalid_params" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is permanent ambiguous_success when Meta returns 2xx without messages[0].id", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ messages: [] }));
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: true,
			code: "ambiguous_success",
		});
	});

	it("is permanent ambiguous_success when a 2xx body is not JSON", async () => {
		fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
		expect(await sendWhatsappNotification(notification)).toMatchObject({ permanent: true, code: "ambiguous_success" });
	});

	it("is permanent ambiguous_success when reading a 2xx body times out", async () => {
		const response = new Response("{}", { status: 200 });
		vi.spyOn(response, "json").mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
		fetchMock.mockResolvedValue(response);
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: true,
			code: "ambiguous_success",
		});
	});

	it("still classifies a non-2xx response whose body is not JSON by status", async () => {
		fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502 }));
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: false,
			code: "provider_unavailable",
		});
	});

	it("classifies a Meta error body", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: { code: 132001, message: "template missing" } }, 400));
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: true,
			code: "template_unavailable",
		});
	});

	it("provider timeout is transient", async () => {
		fetchMock.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
		expect(await sendWhatsappNotification(notification)).toEqual({
			ok: false,
			permanent: false,
			code: "provider_timeout",
		});
	});

	it("never exposes the access token in the result or in logs", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => {}),
		);
		fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed: Bearer ${TOKEN}`));
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 190, message: `token ${TOKEN} expired` } }, 401));

		const results = [await sendWhatsappNotification(notification), await sendWhatsappNotification(notification)];

		expect(JSON.stringify(results)).not.toContain(TOKEN);
		for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
		spies.forEach((spy) => spy.mockRestore());
	});
});
