import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ session: vi.fn(), ref: vi.fn(), open: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: (_identity: unknown, work: (client: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/payouts/queries", () => ({ getPayoutReceiptRef: s.ref }));
vi.mock("@/lib/payouts/receipt", () => ({ openPayoutReceipt: s.open }));

import { SessionAccessError } from "@/lib/auth/session";

import { GET } from "./route";

const bureauA = randomUUID();
const bureauB = randomUUID();
const id = randomUUID();
const identity = { userId: randomUUID(), supportSessionId: null, support: null };
const superadmin = { ...identity, role: "superadmin", bureauId: null };
const adminA = { ...identity, role: "bureau_admin", bureauId: bureauA };

const call = (payoutId: string = id) => GET(new Request(`http://localhost/api/payouts/${payoutId}/receipt`), { params: { id: payoutId } });
const bytes = new Uint8Array([37, 80, 68, 70]);

beforeEach(() => {
	vi.clearAllMocks();
	s.session.mockResolvedValue(adminA);
	s.ref.mockResolvedValue({ bureauId: bureauA, objectKey: "ab/obj", mime: "application/pdf" });
	s.open.mockResolvedValue({ body: new Response(bytes).body, size: bytes.length });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/payouts/[id]/receipt", () => {
	it("serves the owning bureau_admin with the security headers", async () => {
		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("serves the superadmin outside support", async () => {
		s.session.mockResolvedValue(superadmin);
		s.ref.mockResolvedValue({ bureauId: bureauB, objectKey: "ab/obj", mime: "image/png" });

		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
	});

	it.each([
		["application/pdf", "comprovante.pdf"],
		["image/png", "comprovante.png"],
		["image/jpeg", "comprovante.jpg"],
	])("names the %s download %s", async (mime, name) => {
		s.ref.mockResolvedValue({ bureauId: bureauA, objectKey: "ab/obj", mime });

		expect((await call()).headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
	});

	it("answers 401 without a session", async () => {
		s.session.mockRejectedValue(new SessionAccessError("session_required"));

		expect((await call()).status).toBe(401);
		expect(s.ref).not.toHaveBeenCalled();
	});

	it("answers 404 to a bureau_admin of another Bureau", async () => {
		s.ref.mockResolvedValue({ bureauId: bureauB, objectKey: "ab/obj", mime: "application/pdf" });

		const response = await call();

		expect(response.status).toBe(404);
		expect(s.open).not.toHaveBeenCalled();
	});

	it.each(["operator", "client"])("answers 404 to the %s without reading the payout", async (role) => {
		s.session.mockResolvedValue({ ...adminA, role });

		expect((await call()).status).toBe(404);
		expect(s.ref).not.toHaveBeenCalled();
	});

	it("answers 404 to a superadmin in a support session", async () => {
		s.session.mockResolvedValue({ ...superadmin, supportSessionId: randomUUID() });

		expect((await call()).status).toBe(404);
		expect(s.ref).not.toHaveBeenCalled();
	});

	it("answers the same 404 for a missing receipt, a missing object and a malformed id", async () => {
		s.ref.mockResolvedValueOnce(null);
		const noReceipt = await call();
		s.open.mockResolvedValueOnce(null);
		const noObject = await call();
		const badId = await call("not-a-uuid");

		for (const response of [noReceipt, noObject, badId]) {
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("");
		}
	});

	it("answers 500 without leaking details when the read fails", async () => {
		s.open.mockRejectedValue(new Error("disk /secret/path"));

		const response = await call();

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("secret");
	});
});
