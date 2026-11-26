import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const DOSSIER_ID = "00000000-0000-4000-8000-0000000000d1";
const KEY = "00000000-0000-4000-8000-0000000000a1";

const state = vi.hoisted(() => ({
	role: "client" as string,
	getOrderPayment: vi.fn(),
	runCheckout: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://app.example.test" } }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => ({ userId: USER_ID, role: state.role, bureauId: BUREAU_ID, supportSessionId: null })),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/orders/order-pix", () => ({ getOrderPayment: state.getOrderPayment }));
vi.mock("@/lib/payments/checkout", () => ({ runCheckout: state.runCheckout }));

import { createOrderPixAction } from "./order-payment";

const future = () => new Date(Date.now() + 10 * 60_000);
const charge = (over: Record<string, unknown> = {}) => ({
	id: "charge-1",
	status: "pending",
	pixPayload: "000201...",
	expiresAt: future(),
	createdAt: new Date(),
	amountCents: 4500,
	feeCents: 0,
	totalCents: 4500,
	...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
	state: "awaiting_payment",
	priceCents: 4500,
	couponCode: null,
	charge: null,
	...over,
});
const body = (over: Record<string, unknown> = {}) => ({ dossierId: DOSSIER_ID, idempotencyKey: KEY, ...over });

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.getOrderPayment.mockResolvedValue(payment());
	state.runCheckout.mockResolvedValue({ error: null, id: "charge-1", method: "PIX" });
});

describe("createOrderPixAction", () => {
	it("createOrderPixAction ignores the browser amount", async () => {
		await createOrderPixAction(body({ amount: "1.00", method: "CREDIT_CARD", orderId: "x" }));

		expect(state.runCheckout).toHaveBeenCalledTimes(1);
		const [, scope, input, meta] = state.runCheckout.mock.calls[0];
		expect(scope).toEqual({ kind: "client", clientProfileId: USER_ID, orderId: DOSSIER_ID });
		expect(input).toMatchObject({ amount: "45.00", method: "PIX", payerKind: "owner", idempotencyKey: KEY });
		expect(meta).toMatchObject({ remoteIp: "203.0.113.9" });
	});

	it("returns not found for another client's order", async () => {
		state.getOrderPayment.mockResolvedValue(null);

		expect(await createOrderPixAction(body())).toEqual({ error: "Pedido não encontrado." });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("returns reused for a live charge without calling runCheckout", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ charge: charge() }));

		expect(await createOrderPixAction(body())).toEqual({ error: null, id: "charge-1", method: "PIX", reused: true });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("asks to wait when the live charge has no payload yet", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ charge: charge({ pixPayload: null }) }));

		expect(await createOrderPixAction(body())).toEqual({ error: "O PIX está sendo gerado. Aguarde um instante." });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("refuses an order that is not awaiting payment", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ state: "cancelled" }));

		expect(await createOrderPixAction(body())).toEqual({ error: "Este pedido não aguarda pagamento." });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("refuses an expired charge", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ charge: charge({ status: "expired", pixPayload: null }) }));

		expect(await createOrderPixAction(body())).toEqual({ error: "O PIX venceu. O pedido será cancelado." });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("refuses a refunded charge without creating another PIX and without saying it expired", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ charge: charge({ status: "refunded", pixPayload: null }) }));

		expect(await createOrderPixAction(body())).toEqual({ error: "O PIX foi estornado. O pedido será cancelado." });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("uses the live charge of a concurrent submit when runCheckout fails on the unique index", async () => {
		state.getOrderPayment.mockResolvedValueOnce(payment()).mockResolvedValueOnce(payment({ charge: charge() }));
		state.runCheckout.mockResolvedValue({ error: "Não foi possível gerar o PIX. Tente novamente." });

		expect(await createOrderPixAction(body())).toEqual({ error: null, id: "charge-1", method: "PIX", reused: true });
		expect(state.runCheckout).toHaveBeenCalledTimes(1);
	});

	it("keeps the checkout error when no live charge exists after the failure", async () => {
		state.runCheckout.mockResolvedValue({ error: "Preencha os dados de pagamento que faltam." });

		expect(await createOrderPixAction(body())).toEqual({ error: "Preencha os dados de pagamento que faltam." });
	});

	it("refuses a paid charge", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ charge: charge({ status: "paid", pixPayload: null }) }));

		expect(await createOrderPixAction(body())).toEqual({ error: "Pagamento já recebido." });
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("retries after a charge that Asaas refused (cancelled)", async () => {
		state.getOrderPayment.mockResolvedValue(payment({ charge: charge({ status: "cancelled", pixPayload: null }) }));

		await createOrderPixAction(body());

		expect(state.runCheckout).toHaveBeenCalledTimes(1);
	});

	it("refuses staff and invalid bodies before any query", async () => {
		state.role = "bureau_admin";
		expect(await createOrderPixAction(body())).toEqual({ error: "Ação não permitida." });
		state.role = "client";
		expect((await createOrderPixAction({ dossierId: "nope", idempotencyKey: KEY })).error).not.toBeNull();
		expect(state.getOrderPayment).not.toHaveBeenCalled();
	});
});
