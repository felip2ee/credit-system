// Fail closed: sem vaga (limite ou erro em coupon_attempt_begin) o cupom é recusado e o pedido não é tocado.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system_test",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
	});
});

const withUserTransaction = vi.hoisted(() => vi.fn());
const beginCouponAttempt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/transaction", () => ({ withUserTransaction }));
vi.mock("@/lib/coupons/attempt-slot", () => ({ beginCouponAttempt, holdCouponSlot: vi.fn(), clearCouponAttempt: vi.fn() }));

import { placeOrder } from "./queries";
import type { OpenOrderInput } from "./types";

const input: OpenOrderInput = {
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};
const quote = { lines: [] } as never;

describe("placeOrder with a coupon and no slot", () => {
	it("refuses with coupon_invalid without opening the order transaction", async () => {
		beginCouponAttempt.mockResolvedValueOnce(null);
		const result = await placeOrder({ userId: "u", role: "client", bureauId: "b" }, input, quote, { couponCode: "ABC" });
		expect(result).toEqual({ ok: false, reason: "coupon_invalid" });
		expect(withUserTransaction).not.toHaveBeenCalled();
	});
});
