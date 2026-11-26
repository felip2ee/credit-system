import { describe, expect, it } from "vitest";

import type { OrderPayment, OrderPixCharge } from "@/lib/orders/order-pix";

import { afterPoll, orderPixView } from "./order-pix-view";

const NOW = new Date("2026-11-26T12:00:00Z");
const later = new Date(NOW.getTime() + 60_000);

const charge = (over: Partial<OrderPixCharge> = {}): OrderPixCharge => ({
	id: "c1",
	status: "pending",
	pixPayload: "000201",
	expiresAt: later,
	createdAt: NOW,
	amountCents: 5000,
	feeCents: 99,
	totalCents: 5099,
	...over,
});
const payment = (over: Partial<OrderPayment> = {}): OrderPayment => ({
	state: "awaiting_payment",
	priceCents: 5000,
	couponCode: null,
	charge: charge(),
	...over,
});

describe("orderPixView", () => {
	it("leaves when the order is not awaiting payment", () => {
		expect(orderPixView(payment({ state: "awaiting_authorization" }), NOW)).toBe("leave");
	});
	it("generates when there is no charge", () => {
		expect(orderPixView(payment({ charge: null }), NOW)).toBe("generate");
	});
	it("generates again after the gateway refused the charge", () => {
		expect(orderPixView(payment({ charge: charge({ status: "cancelled", pixPayload: null }) }), NOW)).toBe("generate");
	});
	it("shows the QR for a live pending charge", () => {
		expect(orderPixView(payment(), NOW)).toBe("show_qr");
	});
	it("waits while a pending charge has no payload yet", () => {
		expect(orderPixView(payment({ charge: charge({ pixPayload: null }) }), NOW)).toBe("in_progress");
	});
	it("is expired when expiresAt equals now", () => {
		expect(orderPixView(payment({ charge: charge({ expiresAt: NOW }) }), NOW)).toBe("expired");
	});
	it("is expired when the charge status is expired", () => {
		expect(orderPixView(payment({ charge: charge({ status: "expired", pixPayload: null }) }), NOW)).toBe("expired");
	});
	it("shows refunded, not expired, for a refunded charge", () => {
		expect(orderPixView(payment({ charge: charge({ status: "refunded", pixPayload: null }) }), NOW)).toBe("refunded");
	});
	it("tells that the payment came but the order did not start", () => {
		expect(orderPixView(payment({ charge: charge({ status: "paid", pixPayload: null }) }), NOW)).toBe("paid_not_reserved");
	});
});

describe("afterPoll", () => {
	it("goes to the order when paid", () => {
		expect(afterPoll("paid", later, NOW)).toBe("go_to_order");
	});
	it("polls again on timeout before expiresAt", () => {
		expect(afterPoll("timeout", later, NOW)).toBe("poll_again");
	});
	it("is expired on timeout when expiresAt equals now", () => {
		expect(afterPoll("timeout", NOW, NOW)).toBe("expired");
	});
	it("is expired when the charge expired", () => {
		expect(afterPoll("expired", later, NOW)).toBe("expired");
	});
	it("fails when cancelled or refunded", () => {
		expect(afterPoll("cancelled", later, NOW)).toBe("failed");
		expect(afterPoll("refunded", later, NOW)).toBe("failed");
	});
});
