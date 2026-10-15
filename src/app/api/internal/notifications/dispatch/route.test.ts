import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/lib/notifications/dispatch", () => ({ runDispatch: s.run }));
// A config real lê o ambiente inteiro ao ser importada; os leitores têm testes próprios.
vi.mock("@/lib/config", () => ({
	readNotificationsDispatchSecret: (env: NodeJS.ProcessEnv) => {
		if (!env.NOTIFICATIONS_DISPATCH_SECRET) throw new Error("NOTIFICATIONS_DISPATCH_SECRET is required");
		return env.NOTIFICATIONS_DISPATCH_SECRET;
	},
	readWebhookDatabaseUrl: (env: NodeJS.ProcessEnv) => {
		if (!env.DATABASE_WEBHOOK_URL) throw new Error("DATABASE_WEBHOOK_URL is required");
		return env.DATABASE_WEBHOOK_URL;
	},
}));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const SECRET = "d".repeat(32);
const counts = { claimed: 3, sent: 2, retried: 1, failed: 0, suppressed: 0, stale: 0 };

const call = (headers: Record<string, string> = {}) =>
	POST(new Request("http://localhost/api/internal/notifications/dispatch", { method: "POST", headers }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NOTIFICATIONS_DISPATCH_SECRET", SECRET);
	vi.stubEnv("DATABASE_WEBHOOK_URL", "postgres://app_webhook:test@localhost:54329/credit_system");
	s.run.mockResolvedValue(counts);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/internal/notifications/dispatch", () => {
	it("runs the dispatch and returns the counts with the right bearer secret", async () => {
		const res = await call({ authorization: `Bearer ${SECRET}` });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(counts);
		expect(s.run).toHaveBeenCalledOnce();
	});

	it.each([
		["no header", {}],
		["a wrong secret", { authorization: `Bearer ${"e".repeat(32)}` }],
		["a wrong prefix", { authorization: `Basic ${SECRET}` }],
		["the secret without a prefix", { authorization: SECRET }],
	])("answers 401 with %s and does not dispatch", async (_name, headers) => {
		const res = await call(headers);

		expect(res.status).toBe(401);
		expect(s.run).not.toHaveBeenCalled();
	});

	it("answers 500 when the secret is missing, even with a header", async () => {
		vi.stubEnv("NOTIFICATIONS_DISPATCH_SECRET", "");

		const res = await call({ authorization: "Bearer " });

		expect(res.status).toBe(500);
		expect(s.run).not.toHaveBeenCalled();
	});

	it("answers 500 when the webhook database is not configured", async () => {
		vi.stubEnv("DATABASE_WEBHOOK_URL", "");

		expect((await call({ authorization: `Bearer ${SECRET}` })).status).toBe(500);
		expect(s.run).not.toHaveBeenCalled();
	});

	it("answers 500 without a body when the dispatch throws", async () => {
		s.run.mockRejectedValue(new Error("password=hunter2"));

		const res = await call({ authorization: `Bearer ${SECRET}` });

		expect(res.status).toBe(500);
		expect(await res.text()).toBe("");
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("hunter2");
	});

	it.each([
		["GET", GET],
		["PUT", PUT],
		["PATCH", PATCH],
		["DELETE", DELETE],
	])("answers 405 to %s", (_method, handler) => {
		expect(handler().status).toBe(405);
		expect(handler().headers.get("allow")).toBe("POST");
	});
});
