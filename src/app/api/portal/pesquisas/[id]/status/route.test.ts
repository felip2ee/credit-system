import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "abcdef12-0000-4000-8000-0000000000d1";
const TX_CLIENT = { tx: true };

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	getMyOrderState: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: "b1", supportSessionId: null };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work(TX_CLIENT),
}));
vi.mock("@/lib/orders/client-queries", () => ({ getMyOrderState: state.getMyOrderState }));

import { GET } from "./route";

const call = (id = ORDER_ID) => GET(new Request("http://localhost/api/portal/pesquisas/x/status"), { params: { id } });

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	state.getMyOrderState.mockResolvedValue("executing");
});

describe("client order status route", () => {
	it("returns 401 without a session", async () => {
		state.sessionError = new Error("no session");

		expect((await call()).status).toBe(401);
		expect(state.getMyOrderState).not.toHaveBeenCalled();
	});

	it.each(["operator", "bureau_admin", "superadmin"])("returns 403 for the %s role", async (role) => {
		state.role = role;

		expect((await call()).status).toBe(403);
		expect(state.getMyOrderState).not.toHaveBeenCalled();
	});

	it("returns 404 for an id that is not a uuid, without querying", async () => {
		expect((await call("abc")).status).toBe(404);
		expect(state.getMyOrderState).not.toHaveBeenCalled();
	});

	it("returns 404 for another client's order", async () => {
		state.getMyOrderState.mockResolvedValue(null);

		const response = await call();

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(state.getMyOrderState).toHaveBeenCalledWith(TX_CLIENT, ORDER_ID);
	});

	it("returns only the state with no-store", async () => {
		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ state: "executing" });
	});
});
