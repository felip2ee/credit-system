import { afterEach, describe, expect, it, vi } from "vitest";

const withUserTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/transaction", () => ({ withUserTransaction }));

import { isCouponCodeFailure, recordCouponMiss } from "./record-miss";

afterEach(() => vi.restoreAllMocks());

describe("isCouponCodeFailure", () => {
	it.each(["coupon_invalid", "coupon_expired", "coupon_exhausted", "coupon_client_limit", "coupon_product_not_allowed"])(
		"%s counts as a miss",
		(reason) => expect(isCouponCodeFailure(reason)).toBe(true),
	);
	it.each(["coupon_funds_insufficient", "insufficient_funds", "quote_mismatch"])("%s does not count", (reason) =>
		expect(isCouponCodeFailure(reason)).toBe(false),
	);
});

describe("recordCouponMiss", () => {
	it("logs a failure without secrets and does not throw", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		withUserTransaction.mockRejectedValueOnce(new Error("db down"));
		await expect(recordCouponMiss({ userId: "u", role: "client", bureauId: "b" })).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("recordCouponMiss failed", "db down");
	});

	it("skips non-client identities", async () => {
		withUserTransaction.mockClear();
		await recordCouponMiss({ userId: "u", role: "operator", bureauId: "b" });
		expect(withUserTransaction).not.toHaveBeenCalled();
	});
});
