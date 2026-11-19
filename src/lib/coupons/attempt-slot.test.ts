import { afterEach, describe, expect, it, vi } from "vitest";

const withUserTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/transaction", () => ({ withUserTransaction }));

import { beginCouponAttempt, clearCouponAttempt } from "./attempt-slot";

const identity = { userId: "u", role: "client" as const, bureauId: "b" };

afterEach(() => vi.restoreAllMocks());

describe("beginCouponAttempt", () => {
	it("returns the slot id", async () => {
		withUserTransaction.mockResolvedValueOnce("slot-1");
		expect(await beginCouponAttempt(identity)).toBe("slot-1");
	});

	it("fails closed: an error returns null and logs only the message", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		withUserTransaction.mockRejectedValueOnce(new Error("db down"));
		expect(await beginCouponAttempt(identity)).toBeNull();
		expect(log).toHaveBeenCalledWith("beginCouponAttempt failed", "db down");
	});
});

describe("clearCouponAttempt", () => {
	it("never throws: a failure leaves the slot (it keeps counting)", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		withUserTransaction.mockRejectedValueOnce(new Error("db down"));
		await expect(clearCouponAttempt(identity, "slot-1")).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("clearCouponAttempt failed", "db down");
	});
});
