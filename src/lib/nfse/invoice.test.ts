import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	readNfseConfig: vi.fn(),
	schedule: vi.fn(),
	findInvoices: vi.fn(),
	findInstallmentInvoices: vi.fn(),
	findCharge: vi.fn(),
	findChargeByInvoice: vi.fn(),
	findRetryTarget: vi.fn(),
	setStatus: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ readNfseConfig: s.readNfseConfig }));
vi.mock("@/lib/asaas", () => ({
	getAsaasClient: () => ({
		scheduleInvoice: s.schedule,
		findInvoicesByPayment: s.findInvoices,
		findInvoicesByInstallment: s.findInstallmentInvoices,
	}),
}));
vi.mock("./queries", () => ({
	findNfseChargeByInvoice: s.findChargeByInvoice,
	findNfseChargeByPayment: s.findCharge,
	findNfseRetryTarget: s.findRetryTarget,
	setNfseStatus: s.setStatus,
}));

import { AsaasOutcomeUnknownError } from "@/lib/asaas/client";

import {
	applyInvoiceEvent,
	parseInvoiceEvent,
	repairInvoiceForPayment,
	requestInvoiceForPayment,
	rescheduleInvoice,
} from "./invoice";

const service = { municipalServiceId: "svc", municipalServiceName: "n", serviceDescription: "d", issRate: 2, retainIss: false };
const charge = { chargeId: "11111111-1111-4111-8111-111111111111", amount: "100.00", invoiceId: null, installmentId: null };
const identity = { userId: "u", role: "superadmin" as const, bureauId: null };

beforeEach(() => {
	vi.clearAllMocks();
	s.readNfseConfig.mockReturnValue(service);
	s.findCharge.mockResolvedValue(charge);
	s.findChargeByInvoice.mockResolvedValue(null);
	s.findInvoices.mockResolvedValue([]);
	s.findInstallmentInvoices.mockResolvedValue([]);
	s.schedule.mockResolvedValue({ asaasInvoiceId: "inv_1" });
	s.setStatus.mockResolvedValue({ ok: true, status: "pending", changed: true });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("requestInvoiceForPayment", () => {
	it("without municipal configuration records nothing and calls neither Asaas nor the database", async () => {
		s.readNfseConfig.mockReturnValue(null);

		expect(await requestInvoiceForPayment("pay_1")).toBe("not_requested");
		expect(s.findCharge).not.toHaveBeenCalled();
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).not.toHaveBeenCalled();
	});

	it("schedules with the stored amount and the charge id as reference, then records pending", async () => {
		expect(await requestInvoiceForPayment("pay_1")).toBe("pending");

		expect(s.schedule).toHaveBeenCalledWith({
			paymentId: "pay_1",
			amount: "100.00",
			externalReference: charge.chargeId,
			service,
		});
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "pending");
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "pending", { invoiceId: "inv_1" });
	});

	it("invoices the card total the query returns (what the payer paid), not the recharge", async () => {
		s.findCharge.mockResolvedValue({ ...charge, amount: "104.67" });

		await requestInvoiceForPayment("pay_1");

		expect(s.schedule).toHaveBeenCalledWith(expect.objectContaining({ amount: "104.67" }));
	});

	it("sends the installment id of a card plan, once, and nothing for Pix", async () => {
		s.findCharge.mockResolvedValue({ ...charge, amount: "104.67", installmentId: "ins_1" });
		await requestInvoiceForPayment("pay_1");
		s.findCharge.mockResolvedValue(charge);
		await requestInvoiceForPayment("pay_2");

		expect(s.schedule).toHaveBeenNthCalledWith(1, expect.objectContaining({ paymentId: "pay_1", installmentId: "ins_1" }));
		expect(s.schedule.mock.calls[1][0]).not.toHaveProperty("installmentId");
		expect(s.findInstallmentInvoices).toHaveBeenCalledTimes(1);
		expect(s.findInstallmentInvoices).toHaveBeenCalledWith("ins_1");
		expect(s.findInvoices).toHaveBeenCalledTimes(1);
		expect(s.findInvoices).toHaveBeenCalledWith("pay_2");
	});

	it("looks up the invoices of the payment before it schedules", async () => {
		const order: string[] = [];
		s.findInvoices.mockImplementation(async () => (order.push("lookup"), []));
		s.schedule.mockImplementation(async () => (order.push("schedule"), { asaasInvoiceId: "inv_1" }));

		await requestInvoiceForPayment("pay_1");

		expect(order).toEqual(["lookup", "schedule"]);
		expect(s.findInvoices).toHaveBeenCalledWith("pay_1");
	});

	it("adopts an invoice Asaas already has: records its id and never calls POST", async () => {
		s.findInvoices.mockResolvedValue([{ asaasInvoiceId: "inv_old", status: "SCHEDULED", number: null, pdfUrl: null }]);

		expect(await requestInvoiceForPayment("pay_1")).toBe("pending");
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "pending", { invoiceId: "inv_old" });
	});

	it("adopts an already authorized invoice as issued, with its number and url", async () => {
		s.findInvoices.mockResolvedValue([
			{ asaasInvoiceId: "inv_old", status: "AUTHORIZED", number: "77", pdfUrl: "https://nfse.example/77.pdf" },
		]);

		await requestInvoiceForPayment("pay_1");

		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "issued", {
			number: "77",
			url: "https://nfse.example/77.pdf",
			invoiceId: "inv_old",
		});
	});

	it("treats a timeout on POST as unknown: leaves the note pending, never records failed", async () => {
		s.schedule.mockRejectedValue(new AsaasOutcomeUnknownError("Sem resposta do Asaas em POST /v3/invoices (TimeoutError)"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("pending");
		expect(s.setStatus).not.toHaveBeenCalledWith(charge.chargeId, "failed");
		expect(console.error).toHaveBeenCalledWith("[nfse] agendamento falhou", { name: "AsaasOutcomeUnknownError", code: undefined });
	});

	it("does not call POST when the lookup is unknown (timeout): the note stays pending for the reclaim", async () => {
		s.findInvoices.mockRejectedValue(new AsaasOutcomeUnknownError("Sem resposta do Asaas em GET /v3/invoices (TimeoutError)"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("pending");
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).not.toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("records failed, without POST, when the lookup is refused outright (4xx)", async () => {
		s.findInvoices.mockRejectedValue(new Error("Asaas respondeu 401 em GET /v3/invoices"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("failed");
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "failed");
	});

	it("records failed and never throws when Asaas refuses", async () => {
		s.schedule.mockRejectedValue(new Error("Asaas respondeu 500"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("failed");
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("records failed when the configuration is invalid", async () => {
		s.readNfseConfig.mockImplementation(() => {
			throw new Error("NFSE_ISS_RATE is required");
		});

		expect(await requestInvoiceForPayment("pay_1")).toBe("failed");
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("claims not_requested -> pending before it calls Asaas", async () => {
		const order: string[] = [];
		s.setStatus.mockImplementation(async () => (order.push("claim"), { ok: true, status: "pending", changed: true }));
		s.schedule.mockImplementation(async () => (order.push("schedule"), { asaasInvoiceId: "inv_1" }));

		await requestInvoiceForPayment("pay_1");

		expect(order).toEqual(["claim", "schedule", "claim"]);
	});

	it("does not schedule when the claim is not won (already pending, issued or failed)", async () => {
		s.setStatus.mockResolvedValue({ ok: true, status: "pending", changed: false });

		expect(await requestInvoiceForPayment("pay_1")).toBe("not_requested");
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenCalledTimes(1);
	});

	it("two concurrent calls on one charge call Asaas exactly once", async () => {
		let claimed = false;
		s.setStatus.mockImplementation(async (_id: string, status: string) => {
			if (status !== "pending") return { ok: true, status, changed: true };
			await Promise.resolve();
			const changed = !claimed;
			claimed = true;
			return { ok: true, status: "pending", changed };
		});

		await Promise.all([requestInvoiceForPayment("pay_1"), repairInvoiceForPayment("pay_1")]);

		expect(s.schedule).toHaveBeenCalledTimes(1);
	});

	it("does not schedule for an unknown charge", async () => {
		s.findCharge.mockResolvedValue(null);

		expect(await requestInvoiceForPayment("pay_x")).toBe("unknown_charge");
		expect(s.schedule).not.toHaveBeenCalled();
	});

	it("never throws when the database fails", async () => {
		s.findCharge.mockRejectedValue(new Error("connection lost"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("failed");
	});

	it("does not mark failed after Asaas accepted the invoice and only the pending record failed", async () => {
		s.setStatus.mockResolvedValueOnce({ ok: true, status: "pending", changed: true });
		s.setStatus.mockRejectedValue(new Error("connection lost"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("pending");
		expect(s.setStatus).not.toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("still returns failed and logs when recording failed throws too", async () => {
		s.schedule.mockRejectedValue(new Error("Asaas respondeu 500"));
		s.setStatus.mockResolvedValueOnce({ ok: true, status: "pending", changed: true });
		s.setStatus.mockRejectedValue(Object.assign(new Error("connection lost"), { code: "57P01" }));

		expect(await requestInvoiceForPayment("pay_1")).toBe("failed");
		expect(console.error).toHaveBeenCalledWith("[nfse] registro da falha falhou", { name: "Error", code: "57P01" });
	});
});

describe("repairInvoiceForPayment", () => {
	it("claims a not_requested charge with pending, then schedules it", async () => {
		expect(await repairInvoiceForPayment("pay_1")).toBe("pending");

		expect(s.setStatus).toHaveBeenNthCalledWith(1, charge.chargeId, "pending");
		expect(s.schedule).toHaveBeenCalledTimes(1);
	});

	it("re-processes a pending note the database lets it re-claim (stale for more than 10 minutes): lookup first, adopt", async () => {
		// set_nfse_status devolve changed = true para pending com mais de 10 min; o lado do TS só confia nesse bit.
		s.setStatus.mockResolvedValue({ ok: true, status: "pending", changed: true });
		s.findInvoices.mockResolvedValue([{ asaasInvoiceId: "inv_timeout", status: "SCHEDULED", number: null, pdfUrl: null }]);

		expect(await repairInvoiceForPayment("pay_1")).toBe("pending");
		expect(s.findInvoices).toHaveBeenCalledWith("pay_1");
		expect(s.schedule).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "pending", { invoiceId: "inv_timeout" });
	});

	it("never schedules a charge that is already pending, issued or failed", async () => {
		s.setStatus.mockResolvedValue({ ok: true, status: "issued", changed: false });

		expect(await repairInvoiceForPayment("pay_1")).toBe("not_requested");
		expect(s.schedule).not.toHaveBeenCalled();
	});

	it("records failed when Asaas refuses after the claim", async () => {
		s.schedule.mockRejectedValue(new Error("x"));

		expect(await repairInvoiceForPayment("pay_1")).toBe("failed");
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "failed");
	});

	it("without municipal configuration touches nothing; with an unknown charge schedules nothing", async () => {
		s.readNfseConfig.mockReturnValue(null);
		expect(await repairInvoiceForPayment("pay_1")).toBe("not_requested");
		expect(s.findCharge).not.toHaveBeenCalled();

		s.readNfseConfig.mockReturnValue(service);
		s.findCharge.mockResolvedValue(null);
		expect(await repairInvoiceForPayment("pay_x")).toBe("unknown_charge");
		expect(s.schedule).not.toHaveBeenCalled();
	});

	it("never throws when the claim fails", async () => {
		s.setStatus.mockRejectedValue(new Error("connection lost"));

		expect(await repairInvoiceForPayment("pay_1")).toBe("failed");
		expect(s.schedule).not.toHaveBeenCalled();
	});
});

describe("rescheduleInvoice", () => {
	it("keeps the installment id on a retry of a card plan", async () => {
		s.findRetryTarget.mockResolvedValue({ asaasPaymentId: "pay_9", amount: "104.67", installmentId: "ins_9" });

		await rescheduleInvoice(identity, charge.chargeId);

		expect(s.schedule).toHaveBeenCalledWith(expect.objectContaining({ amount: "104.67", installmentId: "ins_9" }));
		expect(s.findInstallmentInvoices).toHaveBeenCalledWith("ins_9");
		expect(s.findInvoices).not.toHaveBeenCalled();
	});

	it("schedules the retry target and records pending", async () => {
		s.findRetryTarget.mockResolvedValue({ asaasPaymentId: "pay_9", amount: "55.00", installmentId: null });

		expect(await rescheduleInvoice(identity, charge.chargeId)).toBe("pending");
		expect(s.schedule).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay_9", amount: "55.00" }));
	});

	it("records failed when Asaas refuses again", async () => {
		s.findRetryTarget.mockResolvedValue({ asaasPaymentId: "pay_9", amount: "55.00", installmentId: null });
		s.schedule.mockRejectedValue(new Error("x"));

		expect(await rescheduleInvoice(identity, charge.chargeId)).toBe("failed");
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("records failed instead of leaving the charge pending when the target is gone", async () => {
		s.findRetryTarget.mockResolvedValue(null);

		expect(await rescheduleInvoice(identity, charge.chargeId)).toBe("unknown_charge");
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("records failed instead of leaving the charge pending when the lookup throws", async () => {
		s.findRetryTarget.mockRejectedValue(new Error("connection lost"));

		expect(await rescheduleInvoice(identity, charge.chargeId)).toBe("failed");
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("never throws when recording failed also throws", async () => {
		s.findRetryTarget.mockRejectedValue(new Error("connection lost"));
		s.setStatus.mockRejectedValue(new Error("connection lost"));

		expect(await rescheduleInvoice(identity, charge.chargeId)).toBe("failed");
	});
});

const event = (name: string, invoice: Record<string, unknown> = {}) => {
	const parsed = parseInvoiceEvent({ event: name, invoice: { payment: "pay_1", ...invoice } });
	if (!parsed.success) throw new Error("bad fixture");
	return parsed.data;
};

describe("applyInvoiceEvent", () => {
	it("INVOICE_AUTHORIZED records issued with number and url", async () => {
		s.setStatus.mockResolvedValue({ ok: true, status: "issued", changed: true });

		const result = await applyInvoiceEvent(event("INVOICE_AUTHORIZED", { number: 123, pdfUrl: "https://nfse.example/1.pdf" }));

		expect(result).toBe("issued");
		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "issued", { number: "123", url: "https://nfse.example/1.pdf" });
	});

	it("drops a number or url the database would refuse instead of failing the issue", async () => {
		await applyInvoiceEvent(event("INVOICE_AUTHORIZED", { number: "x".repeat(60), pdfUrl: "http://insecure.example/1.pdf" }));

		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "issued", { number: null, url: null });
	});

	it("INVOICE_ERROR records failed", async () => {
		await applyInvoiceEvent(event("INVOICE_ERROR"));

		expect(s.setStatus).toHaveBeenCalledWith(charge.chargeId, "failed", {});
	});

	it("INVOICE_UPDATED follows its status; other events change nothing", async () => {
		await applyInvoiceEvent(event("INVOICE_UPDATED", { status: "AUTHORIZED" }));
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "issued", { number: null, url: null });

		s.setStatus.mockClear();
		for (const name of ["INVOICE_CREATED", "INVOICE_CANCELLATION_DENIED", "INVOICE_PROCESSING_CANCELLATION", "INVOICE_UPDATED"]) {
			expect(await applyInvoiceEvent(event(name, { status: "SCHEDULED" }))).toBe("ignored");
		}
		expect(s.setStatus).not.toHaveBeenCalled();
	});

	it("INVOICE_CANCELED (also via UPDATED/CANCELED) stops the receipt: records canceled", async () => {
		s.setStatus.mockResolvedValue({ ok: true, status: "failed", changed: true });

		expect(await applyInvoiceEvent(event("INVOICE_CANCELED"))).toBe("canceled");
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "canceled", {});
		await applyInvoiceEvent(event("INVOICE_UPDATED", { status: "CANCELED" }));
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "canceled", {});
	});

	it("matches the event by invoice id first and only falls back to the payment", async () => {
		const byInvoice = { chargeId: "22222222-2222-4222-8222-222222222222", amount: "5.00" };
		s.findChargeByInvoice.mockResolvedValue(byInvoice);

		await applyInvoiceEvent(event("INVOICE_ERROR", { id: "inv_9" }));
		expect(s.findChargeByInvoice).toHaveBeenCalledWith("inv_9");
		expect(s.findCharge).not.toHaveBeenCalled();
		expect(s.setStatus).toHaveBeenLastCalledWith(byInvoice.chargeId, "failed", {});

		s.findChargeByInvoice.mockResolvedValue(null);
		await applyInvoiceEvent(event("INVOICE_ERROR", { id: "inv_unknown" }));
		expect(s.findCharge).toHaveBeenCalledWith("pay_1");
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "failed", {});
	});

	it("ignores an event of an old invoice when the charge already holds another one", async () => {
		s.findChargeByInvoice.mockResolvedValue(null);
		s.findCharge.mockResolvedValue({ ...charge, invoiceId: "inv_B" });

		expect(await applyInvoiceEvent(event("INVOICE_CANCELED", { id: "inv_A" }))).toBe("ignored");
		expect(s.setStatus).not.toHaveBeenCalled();
	});

	it("still falls back to the payment when the charge holds no invoice yet, or the event has no id", async () => {
		s.findChargeByInvoice.mockResolvedValue(null);
		s.findCharge.mockResolvedValue({ ...charge, invoiceId: null });
		await applyInvoiceEvent(event("INVOICE_ERROR", { id: "inv_A" }));
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "failed", {});

		s.findCharge.mockResolvedValue({ ...charge, invoiceId: "inv_B" });
		await applyInvoiceEvent(event("INVOICE_ERROR"));
		expect(s.setStatus).toHaveBeenCalledTimes(2);
		expect(s.setStatus).toHaveBeenLastCalledWith(charge.chargeId, "failed", {});
	});

	it("a duplicate issued event is reported unchanged (the database does not regress or rewrite it)", async () => {
		s.setStatus.mockResolvedValue({ ok: true, status: "issued", changed: false });

		expect(await applyInvoiceEvent(event("INVOICE_AUTHORIZED", { number: "1" }))).toBe("unchanged");
	});

	it("ignores an event for an unknown charge", async () => {
		s.findCharge.mockResolvedValue(null);

		expect(await applyInvoiceEvent(event("INVOICE_AUTHORIZED"))).toBe("unknown_charge");
		expect(s.setStatus).not.toHaveBeenCalled();
	});
});

describe("parseInvoiceEvent", () => {
	it("requires invoice.payment", () => {
		expect(parseInvoiceEvent({ event: "INVOICE_AUTHORIZED", invoice: {} }).success).toBe(false);
		expect(parseInvoiceEvent({ event: "INVOICE_AUTHORIZED" }).success).toBe(false);
	});
});
