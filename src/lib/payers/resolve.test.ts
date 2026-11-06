import { describe, expect, it, vi, type Mock } from "vitest";

import type { AsaasClient } from "@/lib/asaas/types";

import type { OwnerPayerView, ResolvedPayer } from "./queries";
import { missingPayerFields, requiredOtherPayerFields, resolveAsaasCustomer } from "./resolve";

class OutcomeUnknown extends Error {}

const PAYER: ResolvedPayer = {
	name: "Maria Souza",
	cpfCnpj: "52998224725",
	email: "maria@example.test",
	phone: "+5511999998888",
	postalCode: "01310100",
	addressNumber: "123",
};

type CustomerCalls = {
	findCustomerByCpfCnpj: Mock<AsaasClient["findCustomerByCpfCnpj"]>;
	createCustomer: Mock<AsaasClient["createCustomer"]>;
	updateCustomer: Mock<AsaasClient["updateCustomer"]>;
};

function fakeAsaas(overrides: Partial<CustomerCalls> = {}): CustomerCalls & AsaasClient {
	const asaas: CustomerCalls = {
		findCustomerByCpfCnpj: vi.fn<AsaasClient["findCustomerByCpfCnpj"]>(async () => null),
		createCustomer: vi.fn<AsaasClient["createCustomer"]>(async () => ({ asaasCustomerId: "cus_new" })),
		updateCustomer: vi.fn<AsaasClient["updateCustomer"]>(async () => {}),
		...overrides,
	};
	return asaas as CustomerCalls & AsaasClient;
}

function deps(asaas: AsaasClient, winner?: string) {
	const claim = vi.fn(async (id: string) => winner ?? id);
	const markSynced = vi.fn(async () => {});
	return { asaas, claim, markSynced };
}

describe("resolveAsaasCustomer", () => {
	it("owner with id and not stale: no Asaas call", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, {
			payer: PAYER,
			kind: "owner",
			current: { asaasCustomerId: "cus_1", owned: true, stale: false },
			payerProfileId: "p1",
		});
		expect(id).toBe("cus_1");
		expect(asaas.findCustomerByCpfCnpj).not.toHaveBeenCalled();
		expect(asaas.createCustomer).not.toHaveBeenCalled();
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
	});

	it("stale and owned: updates the customer and marks synced", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, {
			payer: PAYER,
			kind: "owner",
			current: { asaasCustomerId: "cus_1", owned: true, stale: true },
			payerProfileId: "p1",
		});
		expect(id).toBe("cus_1");
		expect(asaas.updateCustomer).toHaveBeenCalledWith(
			"cus_1",
			expect.objectContaining({ cpfCnpj: PAYER.cpfCnpj, mobilePhone: "11999998888", postalCode: "01310100" }),
		);
		expect(d.markSynced).toHaveBeenCalledOnce();
	});

	it("stale but not owned: never updates a customer we did not create", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, {
			payer: PAYER,
			kind: "owner",
			current: { asaasCustomerId: "cus_alheio", owned: false, stale: true },
			payerProfileId: "p1",
		});
		expect(id).toBe("cus_alheio");
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
		expect(d.markSynced).not.toHaveBeenCalled();
	});

	it("no id and search finds one: adopts it with owned=false, no create", async () => {
		const asaas = fakeAsaas({ findCustomerByCpfCnpj: vi.fn<AsaasClient["findCustomerByCpfCnpj"]>(async () => "cus_found") });
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, {
			payer: PAYER,
			kind: "owner",
			current: { asaasCustomerId: null, owned: false, stale: false },
			payerProfileId: "p1",
		});
		expect(id).toBe("cus_found");
		expect(d.claim).toHaveBeenCalledWith("cus_found", false);
		expect(asaas.createCustomer).not.toHaveBeenCalled();
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
	});

	it("no id and empty search: creates with externalReference and claims owned=true", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, {
			payer: PAYER,
			kind: "owner",
			current: null,
			payerProfileId: "p1",
		});
		expect(id).toBe("cus_new");
		expect(asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ externalReference: "p1" }));
		expect(d.claim).toHaveBeenCalledWith("cus_new", true);
	});

	it("claim lost the race: returns the winner id", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const asaas = fakeAsaas();
		const d = deps(asaas, "cus_winner");
		const id = await resolveAsaasCustomer(d, { payer: PAYER, kind: "owner", current: null, payerProfileId: "p1" });
		expect(id).toBe("cus_winner");
		expect(warn).toHaveBeenCalledOnce();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(PAYER.cpfCnpj);
		warn.mockRestore();
	});

	it("other: finds and reuses without update or claim", async () => {
		const asaas = fakeAsaas({ findCustomerByCpfCnpj: vi.fn<AsaasClient["findCustomerByCpfCnpj"]>(async () => "cus_found") });
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, { payer: PAYER, kind: "other", current: null, payerProfileId: null });
		expect(id).toBe("cus_found");
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
		expect(d.claim).not.toHaveBeenCalled();
	});

	it("other: creates without externalReference, never claims or updates", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, { payer: PAYER, kind: "other", current: null, payerProfileId: null });
		expect(id).toBe("cus_new");
		const arg = asaas.createCustomer.mock.calls[0][0];
		expect(arg).not.toHaveProperty("externalReference");
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
		expect(d.claim).not.toHaveBeenCalled();
	});

	it("other ignores a stale owner customer in `current`", async () => {
		const asaas = fakeAsaas({ findCustomerByCpfCnpj: vi.fn<AsaasClient["findCustomerByCpfCnpj"]>(async () => "cus_other") });
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, {
			payer: PAYER,
			kind: "other",
			current: { asaasCustomerId: "cus_owner", owned: true, stale: true },
			payerProfileId: "p1",
		});
		expect(id).toBe("cus_other");
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
	});

	it("outcome unknown on create: error surfaces, second attempt adopts by search", async () => {
		const created: string[] = [];
		const asaas = fakeAsaas({
			createCustomer: vi.fn<AsaasClient["createCustomer"]>(async () => {
				created.push("cus_hidden");
				throw new OutcomeUnknown();
			}),
		});
		const d = deps(asaas);
		await expect(
			resolveAsaasCustomer(d, { payer: PAYER, kind: "owner", current: null, payerProfileId: "p1" }),
		).rejects.toBeInstanceOf(OutcomeUnknown);
		expect(d.claim).not.toHaveBeenCalled();

		// O cliente existe no Asaas; a segunda tentativa o acha pela busca e não cria.
		asaas.findCustomerByCpfCnpj.mockResolvedValueOnce("cus_hidden");
		const id = await resolveAsaasCustomer(d, { payer: PAYER, kind: "owner", current: null, payerProfileId: "p1" });
		expect(id).toBe("cus_hidden");
		expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
		expect(d.claim).toHaveBeenCalledWith("cus_hidden", false);
	});

	it("omits non-Brazilian phone and missing address from the Asaas input", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		await resolveAsaasCustomer(d, {
			payer: { ...PAYER, phone: "+14155550100", postalCode: null, addressNumber: null },
			kind: "other",
			current: null,
			payerProfileId: null,
		});
		const arg = asaas.createCustomer.mock.calls[0][0];
		expect(arg).not.toHaveProperty("mobilePhone");
		expect(arg).not.toHaveProperty("postalCode");
		expect(arg).not.toHaveProperty("addressNumber");
	});
});

describe("missingPayerFields", () => {
	const complete: OwnerPayerView = {
		name: "Maria",
		emailMasked: "m***@example.test",
		phoneMasked: "(**) *****-8888",
		documentMasked: "***.298.***-**",
		postalCodeMasked: "*****-100",
		hasAddressNumber: true,
		source: "payer_profile",
	};
	const empty: OwnerPayerView = {
		...complete,
		name: null,
		phoneMasked: null,
		documentMasked: null,
		postalCodeMasked: null,
		hasAddressNumber: false,
		source: "none",
	};

	it("Pix, complete owner: nothing is asked", () => {
		expect(missingPayerFields(complete, "PIX", true)).toEqual([]);
		expect(missingPayerFields(complete, "PIX", false)).toEqual([]);
	});

	it("Pix, empty owner, NFS-e off: only name and document", () => {
		expect(missingPayerFields(empty, "PIX", false)).toEqual(["name", "document"]);
	});

	it("Pix, empty owner, NFS-e on: adds postal code and address number, never phone", () => {
		expect(missingPayerFields(empty, "PIX", true)).toEqual(["name", "document", "postalCode", "addressNumber"]);
	});

	it("card, empty owner: asks phone and address whatever the NFS-e flag", () => {
		const all = ["name", "document", "phone", "postalCode", "addressNumber"];
		expect(missingPayerFields(empty, "CREDIT_CARD", false)).toEqual(all);
		expect(missingPayerFields(empty, "CREDIT_CARD", true)).toEqual(all);
	});

	it("card, owner with everything but the phone: asks only the phone", () => {
		expect(missingPayerFields({ ...complete, phoneMasked: null }, "CREDIT_CARD", false)).toEqual(["phone"]);
	});

	it("other flow requires every field", () => {
		expect(requiredOtherPayerFields()).toEqual(["name", "document", "email", "phone", "postalCode", "addressNumber"]);
	});
});
