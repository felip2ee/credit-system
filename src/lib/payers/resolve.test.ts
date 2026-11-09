import { describe, expect, it, vi, type Mock } from "vitest";

import { AsaasHttpError } from "@/lib/asaas/client";
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
	findCustomerByExternalReference: Mock<AsaasClient["findCustomerByExternalReference"]>;
	customerExists: Mock<AsaasClient["customerExists"]>;
	createCustomer: Mock<AsaasClient["createCustomer"]>;
	updateCustomer: Mock<AsaasClient["updateCustomer"]>;
};

function fakeAsaas(overrides: Partial<CustomerCalls> = {}): CustomerCalls & AsaasClient {
	const asaas: CustomerCalls = {
		findCustomerByExternalReference: vi.fn<AsaasClient["findCustomerByExternalReference"]>(async () => null),
		customerExists: vi.fn<AsaasClient["customerExists"]>(async () => true),
		createCustomer: vi.fn<AsaasClient["createCustomer"]>(async () => ({ asaasCustomerId: "cus_new" })),
		updateCustomer: vi.fn<AsaasClient["updateCustomer"]>(async () => {}),
		...overrides,
	};
	return asaas as CustomerCalls & AsaasClient;
}

function deps(asaas: AsaasClient, winner?: string) {
	const claim = vi.fn(async (id: string) => winner ?? id);
	const markSynced = vi.fn(async () => {});
	const forget = vi.fn(async (_deadId: string) => {});
	return { asaas, claim, markSynced, forget };
}

type Current = { asaasCustomerId: string | null; owned: boolean; stale: boolean } | null;
const CHARGE = "charge-1";
const owner = (current: Current, payerProfileId = "p1") =>
	({ payer: PAYER, kind: "owner", current, payerProfileId, chargeId: CHARGE }) as const;
const other = (current: Current = null) =>
	({ payer: PAYER, kind: "other", current, payerProfileId: null, chargeId: CHARGE }) as const;

describe("resolveAsaasCustomer", () => {
	it("owner with id and not stale: no Asaas call", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, owner({ asaasCustomerId: "cus_1", owned: true, stale: false }));
		expect(id).toBe("cus_1");
		expect(asaas.findCustomerByExternalReference).not.toHaveBeenCalled();
		expect(asaas.createCustomer).not.toHaveBeenCalled();
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
	});

	it("stale and owned: updates the customer and marks synced", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, owner({ asaasCustomerId: "cus_1", owned: true, stale: true }));
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
		const id = await resolveAsaasCustomer(d, owner({ asaasCustomerId: "cus_alheio", owned: false, stale: true }));
		expect(id).toBe("cus_alheio");
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
		expect(d.markSynced).not.toHaveBeenCalled();
	});

	it("owner with no id: converges by the payer profile reference and claims owned", async () => {
		const asaas = fakeAsaas({ findCustomerByExternalReference: vi.fn(async () => "cus_mine") });
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, owner({ asaasCustomerId: null, owned: false, stale: false }));
		expect(id).toBe("cus_mine");
		expect(asaas.findCustomerByExternalReference).toHaveBeenCalledWith("p1");
		expect(d.claim).toHaveBeenCalledWith("cus_mine", true);
		expect(asaas.createCustomer).not.toHaveBeenCalled();
	});

	it("owner with no id and no reference match: creates with the profile reference and claims owned", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, owner(null));
		expect(id).toBe("cus_new");
		expect(asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ externalReference: "p1" }));
		expect(d.claim).toHaveBeenCalledWith("cus_new", true);
	});

	it("claim lost the race: returns the winner id", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const asaas = fakeAsaas();
		const d = deps(asaas, "cus_winner");
		const id = await resolveAsaasCustomer(d, owner(null));
		expect(id).toBe("cus_winner");
		expect(warn).toHaveBeenCalledOnce();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(PAYER.cpfCnpj);
		warn.mockRestore();
	});

	it("other: always creates a new customer with the charge as reference, never claims or updates", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, other());
		expect(id).toBe("cus_new");
		expect(asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ externalReference: CHARGE }));
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
		expect(d.claim).not.toHaveBeenCalled();
	});

	it("other: a retry converges on the customer already made for the same charge", async () => {
		const asaas = fakeAsaas({ findCustomerByExternalReference: vi.fn(async () => "cus_same_charge") });
		const id = await resolveAsaasCustomer(deps(asaas), other());
		expect(id).toBe("cus_same_charge");
		expect(asaas.findCustomerByExternalReference).toHaveBeenCalledWith(CHARGE);
		expect(asaas.createCustomer).not.toHaveBeenCalled();
	});

	it("other ignores a stale owner customer in `current`", async () => {
		const asaas = fakeAsaas();
		const id = await resolveAsaasCustomer(deps(asaas), other({ asaasCustomerId: "cus_owner", owned: true, stale: true }));
		expect(id).toBe("cus_new");
		expect(asaas.updateCustomer).not.toHaveBeenCalled();
	});

	it("outcome unknown on create: error surfaces, second attempt converges by the reference", async () => {
		const asaas = fakeAsaas({
			createCustomer: vi.fn<AsaasClient["createCustomer"]>(async () => {
				throw new OutcomeUnknown();
			}),
		});
		const d = deps(asaas);
		await expect(resolveAsaasCustomer(d, owner(null))).rejects.toBeInstanceOf(OutcomeUnknown);
		expect(d.claim).not.toHaveBeenCalled();

		// O cliente existe no Asaas; a segunda tentativa o acha pela referência e não cria.
		asaas.findCustomerByExternalReference.mockResolvedValueOnce("cus_hidden");
		const id = await resolveAsaasCustomer(d, owner(null));
		expect(id).toBe("cus_hidden");
		expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
		expect(d.claim).toHaveBeenCalledWith("cus_hidden", true);
	});

	it("update 404 and the customer is gone: forgets the id once and makes a new customer", async () => {
		const asaas = fakeAsaas({
			updateCustomer: vi.fn<AsaasClient["updateCustomer"]>(async () => {
				throw new AsaasHttpError(404, "PUT /v3/customers/{id}");
			}),
			customerExists: vi.fn<AsaasClient["customerExists"]>(async () => false),
		});
		const d = deps(asaas);
		const id = await resolveAsaasCustomer(d, owner({ asaasCustomerId: "cus_dead", owned: true, stale: true }));
		expect(id).toBe("cus_new");
		expect(d.forget).toHaveBeenCalledTimes(1);
		expect(d.forget).toHaveBeenCalledWith("cus_dead");
		expect(asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ externalReference: "p1" }));
		expect(d.claim).toHaveBeenCalledWith("cus_new", true);
		expect(d.markSynced).not.toHaveBeenCalled();
	});

	it("update 400 while the customer still exists (invalid data): keeps the id and surfaces the error", async () => {
		const asaas = fakeAsaas({
			updateCustomer: vi.fn<AsaasClient["updateCustomer"]>(async () => {
				throw new AsaasHttpError(400, "PUT /v3/customers/{id}");
			}),
		});
		const d = deps(asaas);
		await expect(
			resolveAsaasCustomer(d, owner({ asaasCustomerId: "cus_1", owned: true, stale: true })),
		).rejects.toBeInstanceOf(AsaasHttpError);
		expect(d.forget).not.toHaveBeenCalled();
		expect(asaas.createCustomer).not.toHaveBeenCalled();
	});

	it("update with an unknown outcome surfaces and forgets nothing", async () => {
		const asaas = fakeAsaas({
			updateCustomer: vi.fn<AsaasClient["updateCustomer"]>(async () => {
				throw new OutcomeUnknown();
			}),
		});
		const d = deps(asaas);
		await expect(
			resolveAsaasCustomer(d, owner({ asaasCustomerId: "cus_1", owned: true, stale: true })),
		).rejects.toBeInstanceOf(OutcomeUnknown);
		expect(d.forget).not.toHaveBeenCalled();
	});

	it("omits non-Brazilian phone and missing address from the Asaas input", async () => {
		const asaas = fakeAsaas();
		const d = deps(asaas);
		await resolveAsaasCustomer(d, {
			...other(),
			payer: { ...PAYER, phone: "+14155550100", postalCode: null, addressNumber: null },
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
