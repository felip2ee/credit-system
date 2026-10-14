import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	readNfseConfig: vi.fn(),
	schedule: vi.fn(),
	findCharge: vi.fn(),
	findRetryTarget: vi.fn(),
	setStatus: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ readNfseConfig: s.readNfseConfig }));
vi.mock("@/lib/asaas", () => ({ getAsaasClient: () => ({ scheduleInvoice: s.schedule }) }));
vi.mock("./queries", () => ({
	findNfseChargeByPayment: s.findCharge,
	findNfseRetryTarget: s.findRetryTarget,
	setNfseStatus: s.setStatus,
}));

import {
	applyInvoiceEvent,
	parseInvoiceEvent,
	repairInvoiceForPayment,
	requestInvoiceForPayment,
	rescheduleInvoice,
} from "./invoice";

const service = { municipalServiceId: "svc", municipalServiceName: "n", serviceDescription: "d", issRate: 2, retainIss: false };
const charge = { chargeId: "11111111-1111-4111-8111-111111111111", amount: "100.00" };
const identity = { userId: "u", role: "superadmin" as const, bureauId: null };

beforeEach(() => {
	vi.clearAllMocks();
	s.readNfseConfig.mockReturnValue(service);
	s.findCharge.mockResolvedValue(charge);
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
		s.setStatus.mockRejectedValue(new Error("connection lost"));

		expect(await requestInvoiceForPayment("pay_1")).toBe("pending");
		expect(s.setStatus).not.toHaveBeenCalledWith(charge.chargeId, "failed");
	});

	it("still returns failed and logs when recording failed throws too", async () => {
		s.schedule.mockRejectedValue(new Error("Asaas respondeu 500"));
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
	it("schedules the retry target and records pending", async () => {
		s.findRetryTarget.mockResolvedValue({ asaasPaymentId: "pay_9", amount: "55.00" });

		expect(await rescheduleInvoice(identity, charge.chargeId)).toBe("pending");
		expect(s.schedule).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay_9", amount: "55.00" }));
	});

	it("records failed when Asaas refuses again", async () => {
		s.findRetryTarget.mockResolvedValue({ asaasPaymentId: "pay_9", amount: "55.00" });
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
		for (const name of ["INVOICE_CREATED", "INVOICE_CANCELED", "INVOICE_UPDATED"]) {
			expect(await applyInvoiceEvent(event(name, { status: "SCHEDULED" }))).toBe("ignored");
		}
		expect(s.setStatus).not.toHaveBeenCalled();
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
