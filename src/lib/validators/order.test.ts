import { describe, expect, it } from "vitest";

import { clientOrderSchema, counterOrderSchema, orderIdSchema, revokeSchema } from "./order";

const CPF = "529.982.247-25";
const CPF_DIGITS = "52998224725";
const CNPJ = "11.222.333/0001-81";
const CNPJ_DIGITS = "11222333000181";
const UUID = "3f1f3a52-6a4f-4d6b-9a55-2b3d6a1c9e10";

const third = (over: Record<string, unknown> = {}) => ({
	productCode: "consulta_pf",
	withAi: false,
	self: false,
	subject: { name: "Maria Souza", document: CPF },
	contactEmail: "maria@example.com",
	...over,
});

describe("clientOrderSchema", () => {
	it("accepts a third-party PF order and returns digits, type and the trimmed phone", () => {
		const parsed = clientOrderSchema.safeParse(third({ contactPhone: "(63) 99234-5615" }));
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.subject).toEqual({ type: "PF", name: "Maria Souza", documentDigits: CPF_DIGITS });
		expect(parsed.data.contactEmail).toBe("maria@example.com");
		expect(parsed.data.contactPhone).toBe("(63) 99234-5615");
	});

	it("refuses a CNPJ for consulta_pf and a CPF for consulta_pj", () => {
		const pf = clientOrderSchema.safeParse(third({ subject: { name: "Empresa", document: CNPJ } }));
		expect(pf.success).toBe(false);
		expect(pf.error?.issues.map((i) => i.message)).toContain("CPF inválido.");
		const pj = clientOrderSchema.safeParse(third({ productCode: "consulta_pj", subject: { name: "Maria", document: CPF } }));
		expect(pj.success).toBe(false);
		expect(pj.error?.issues.map((i) => i.message)).toContain("CNPJ inválido.");
		expect(clientOrderSchema.safeParse(third({ productCode: "consulta_pj", subject: { name: "Empresa", document: CNPJ } })).success).toBe(true);
	});

	it("requires the contact e-mail for a third party", () => {
		expect(clientOrderSchema.safeParse(third({ contactEmail: undefined })).success).toBe(false);
		expect(clientOrderSchema.safeParse(third({ contactEmail: "sem-arroba" })).success).toBe(false);
	});

	it("accepts an own order without subject or contact and drops what the client typed", () => {
		const parsed = clientOrderSchema.safeParse({ productCode: "consulta_pf", withAi: true, self: true });
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toMatchObject({ self: true, withAi: true, subject: null, contactEmail: null, contactPhone: null });
	});

	it("refuses the complete dossier and a phone over 30 characters", () => {
		expect(clientOrderSchema.safeParse(third({ productCode: "dossie_pj_completo" })).success).toBe(false);
		expect(clientOrderSchema.safeParse(third({ contactPhone: "9".repeat(31) })).success).toBe(false);
	});
});

describe("counterOrderSchema", () => {
	const base = (over: Record<string, unknown> = {}) => ({
		productCode: "consulta_pj",
		withAi: false,
		buyerProfileId: null,
		subject: { name: "Empresa Ltda", document: CNPJ },
		...over,
	});

	it("accepts partners only for the complete dossier", () => {
		const partner = { document: CPF, name: "Sócio Um", email: "socio@example.test", percentage: 50, role: "Sócio" };
		const full = counterOrderSchema.safeParse(base({ productCode: "dossie_pj_completo", partners: [partner] }));
		expect(full.success).toBe(true);
		if (full.success) {
			expect(full.data.partners).toEqual([{ documentDigits: CPF_DIGITS, name: "Sócio Um", email: "socio@example.test", percentage: 50, role: "Sócio" }]);
			expect(full.data.subject).toEqual({ type: "PJ", name: "Empresa Ltda", documentDigits: CNPJ_DIGITS });
		}
		expect(counterOrderSchema.safeParse(base({ partners: [partner] })).success).toBe(false);
	});

	it("requires a valid e-mail for each partner", () => {
		const partner = { document: CPF, name: "Sócio Um" };
		const refuse = (email: unknown) =>
			counterOrderSchema.safeParse(base({ productCode: "dossie_pj_completo", partners: [{ ...partner, email }] })).success;
		expect(refuse(undefined)).toBe(false);
		expect(refuse("")).toBe(false);
		expect(refuse("sem-arroba")).toBe(false);
		expect(refuse("socio@example.test")).toBe(true);
	});

	it("refuses an invalid partner CPF, more than 20 partners and a bad buyer id", () => {
		const bad = { document: "111.111.111-11", name: "Sócio", email: "socio@example.test" };
		expect(counterOrderSchema.safeParse(base({ productCode: "dossie_pj_completo", partners: [bad] })).success).toBe(false);
		const many = Array.from({ length: 21 }, () => ({ document: CPF, name: "Sócio", email: "socio@example.test" }));
		expect(counterOrderSchema.safeParse(base({ productCode: "dossie_pj_completo", partners: many })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ buyerProfileId: "x" })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ buyerProfileId: UUID })).success).toBe(true);
	});

	it("needs a subject and checks the document kind by product", () => {
		expect(counterOrderSchema.safeParse(base({ subject: undefined })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ subject: { name: "Maria", document: CPF } })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ productCode: "consulta_pf", subject: { name: "Maria", document: CPF } })).success).toBe(true);
	});
});

describe("orderIdSchema and revokeSchema", () => {
	it("checks the uuid", () => {
		expect(orderIdSchema.safeParse(UUID).success).toBe(true);
		expect(orderIdSchema.safeParse("abc").success).toBe(false);
	});

	it("refuses an empty or long reason and trims", () => {
		expect(revokeSchema.safeParse({ dossierId: UUID, reason: "   " }).success).toBe(false);
		expect(revokeSchema.safeParse({ dossierId: UUID, reason: "x".repeat(501) }).success).toBe(false);
		expect(revokeSchema.parse({ dossierId: UUID, reason: "  erro de cadastro " }).reason).toBe("erro de cadastro");
	});
});
