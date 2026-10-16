import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/lib/orders/tick", () => ({ runOrdersTick: s.run }));
// A config real lê o ambiente inteiro ao ser importada; o leitor tem testes próprios.
vi.mock("@/lib/config", () => ({
	readNotificationsDispatchSecret: (env: NodeJS.ProcessEnv) => {
		if (!env.NOTIFICATIONS_DISPATCH_SECRET) throw new Error("NOTIFICATIONS_DISPATCH_SECRET is required");
		return env.NOTIFICATIONS_DISPATCH_SECRET;
	},
}));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const SECRET = "d".repeat(32);
const counts = { bureaus: 1, expired: 0, cancelled: 0, requested: 1, promoted: 0, executed: 1, ai: 0, released: 0, errors: 0 };

const call = (headers: Record<string, string> = {}) =>
	POST(new Request("http://localhost/api/internal/orders/tick", { method: "POST", headers }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NOTIFICATIONS_DISPATCH_SECRET", SECRET);
	s.run.mockResolvedValue(counts);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/internal/orders/tick", () => {
	it("runs the tick and returns the counts with the right bearer secret", async () => {
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
	])("tick route refuses a wrong secret: %s", async (_name, headers) => {
		const res = await call(headers);

		expect(res.status).toBe(401);
		expect(s.run).not.toHaveBeenCalled();
	});

	it("answers 500 when the secret is not configured, even with a header", async () => {
		vi.stubEnv("NOTIFICATIONS_DISPATCH_SECRET", "");

		const res = await call({ authorization: "Bearer " });

		expect(res.status).toBe(500);
		expect(s.run).not.toHaveBeenCalled();
	});

	it("answers 500 with the counts when a step failed", async () => {
		s.run.mockResolvedValue({ ...counts, errors: 2 });

		const res = await call({ authorization: `Bearer ${SECRET}` });

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ ...counts, errors: 2 });
	});

	it("answers 500 without a body and without leaking the message when the tick throws", async () => {
		s.run.mockRejectedValue(new Error("senha=segredo-do-banco"));

		const res = await call({ authorization: `Bearer ${SECRET}` });

		expect(res.status).toBe(500);
		expect(await res.text()).toBe("");
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("segredo-do-banco");
	});

	it.each([
		["GET", GET],
		["PUT", PUT],
		["PATCH", PATCH],
		["DELETE", DELETE],
	])("answers 405 to %s", (_name, handler) => {
		const res = handler();

		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
		expect(s.run).not.toHaveBeenCalled();
	});
});
