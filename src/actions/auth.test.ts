import { beforeEach, describe, expect, it, vi } from "vitest";

const TX_CLIENT = { tx: true };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	order: [] as string[],
	remove: vi.fn(),
	signOut: vi.fn(),
	redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: state.redirect }));
vi.mock("@/lib/auth/server", () => ({ auth: { api: { signOut: state.signOut } } }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: "u1", role: state.role, bureauId: "b1", supportSessionId: null, permissions: [] };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work(TX_CLIENT),
}));
vi.mock("@/lib/notifications/push-subscriptions", () => ({ removePushSubscription: state.remove }));

import { signOut } from "./auth";

function form(endpoint?: string): FormData {
	const data = new FormData();
	if (endpoint !== undefined) data.set("pushEndpoint", endpoint);
	return data;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	state.order = [];
	state.remove.mockImplementation(async () => {
		state.order.push("remove");
		return { ok: true };
	});
	state.signOut.mockImplementation(async () => {
		state.order.push("signOut");
	});
	state.redirect.mockImplementation(() => {
		state.order.push("redirect");
	});
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("signOut", () => {
	it("removes the device subscription, then signs out and redirects", async () => {
		await signOut(form(ENDPOINT));

		expect(state.remove).toHaveBeenCalledWith(TX_CLIENT, ENDPOINT);
		expect(state.order).toEqual(["remove", "signOut", "redirect"]);
		expect(state.redirect).toHaveBeenCalledWith("/login");
	});

	it("keeps signing out when the removal throws, and logs no endpoint", async () => {
		state.remove.mockRejectedValue(new Error(`boom ${ENDPOINT}`));

		await signOut(form(ENDPOINT));

		expect(state.signOut).toHaveBeenCalledOnce();
		expect(state.redirect).toHaveBeenCalledWith("/login");
		expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("fcm.googleapis.com");
	});

	it("keeps signing out when the session lookup throws", async () => {
		state.sessionError = new Error("session_required");

		await signOut(form(ENDPOINT));

		expect(state.remove).not.toHaveBeenCalled();
		expect(state.signOut).toHaveBeenCalledOnce();
	});

	it.each([
		["no FormData", undefined],
		["no endpoint field", form()],
		["an endpoint outside the allowlist", form("https://evil.com/x")],
	])("does not remove anything with %s", async (_name, data) => {
		await signOut(data);

		expect(state.remove).not.toHaveBeenCalled();
		expect(state.signOut).toHaveBeenCalledOnce();
		expect(state.redirect).toHaveBeenCalledWith("/login");
	});

	it.each(["operator", "bureau_admin", "superadmin"])("does not remove anything for the %s session", async (role) => {
		state.role = role;

		await signOut(form(ENDPOINT));

		expect(state.remove).not.toHaveBeenCalled();
		expect(state.signOut).toHaveBeenCalledOnce();
	});
});
