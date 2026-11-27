import { describe, expect, it } from "vitest";

import { MAX_PARTNERS, clientOrderSchema, counterOrderSchema, duplicateEmailIndexes, orderIdSchema, revokeSchema, updateOrderContactSchema } from "./order";

const CPF = "529.982.247-25";
const CPF_DIGITS = "52998224725";
const CNPJ = "11.222.333/0001-81";
const CNPJ_DIGITS = "11222333000181";
const UUID = "3f1f3a52-6a4f-4d6b-9a55-2b3d6a1c9e10";

const third = (over: Record<string, unknown> = {}) => ({
	productCode: "dossie_pf",
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

	it("refuses a CNPJ for dossie_pf and a CPF for dossie_empresarial", () => {
		const pf = clientOrderSchema.safeParse(third({ subject: { name: "Empresa", document: CNPJ } }));
		expect(pf.success).toBe(false);
		expect(pf.error?.issues.map((i) => i.message)).toContain("CPF inválido.");
		const pj = clientOrderSchema.safeParse(third({ productCode: "dossie_empresarial", subject: { name: "Maria", document: CPF } }));
		expect(pj.success).toBe(false);
		expect(pj.error?.issues.map((i) => i.message)).toContain("CNPJ inválido.");
		expect(clientOrderSchema.safeParse(third({ productCode: "dossie_empresarial", subject: { name: "Empresa", document: CNPJ } })).success).toBe(true);
	});

	it("takes the declaration version the form showed: a positive integer, or none", () => {
		const parsed = clientOrderSchema.safeParse(third({ declarationVersion: 4 }));
		expect(parsed.success && parsed.data.declarationVersion).toBe(4);
		const none = clientOrderSchema.safeParse(third());
		expect(none.success && none.data.declarationVersion).toBeNull();
		for (const bad of [0, -1, 1.5, "3"]) expect(clientOrderSchema.safeParse(third({ declarationVersion: bad })).success).toBe(false);
	});

	it("requires the contact e-mail for a third party", () => {
		expect(clientOrderSchema.safeParse(third({ contactEmail: undefined })).success).toBe(false);
		expect(clientOrderSchema.safeParse(third({ contactEmail: "sem-arroba" })).success).toBe(false);
	});

	it("accepts an own order without subject or contact and drops what the client typed", () => {
		const parsed = clientOrderSchema.safeParse({ productCode: "dossie_pf", self: true });
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toMatchObject({ self: true, subject: null, contactEmail: null, contactPhone: null, partners: [], declarationAccepted: false });
	});

	it("self with empty subject strings passes and yields subject null", () => {
		const parsed = clientOrderSchema.safeParse(
			third({ self: true, subject: { name: "", document: "" }, contactEmail: "", contactPhone: "" }),
		);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toMatchObject({ self: true, subject: null, contactEmail: null, contactPhone: null });
	});

	it("self with an invalid document string still passes", () => {
		const parsed = clientOrderSchema.safeParse(third({ self: true, subject: { name: "x", document: "123" } }));
		expect(parsed.success).toBe(true);
	});

	it("third party with empty subject fails", () => {
		expect(clientOrderSchema.safeParse(third({ subject: { name: "", document: "" } })).success).toBe(false);
	});

	it("refuses an unknown product and a phone over 30 characters", () => {
		expect(clientOrderSchema.safeParse(third({ productCode: "consulta_pf" })).success).toBe(false);
		expect(clientOrderSchema.safeParse(third({ contactPhone: "9".repeat(31) })).success).toBe(false);
	});
});

describe("clientOrderSchema partners", () => {
	const partner = { document: CPF, name: "Sócio Um", email: "socio@example.test", percentage: 50, role: "Sócio" };
	const company = (over: Record<string, unknown> = {}) =>
		third({ productCode: "dossie_empresarial", subject: { name: "Empresa Ltda", document: CNPJ }, ...over });

	it("refuses partners on dossie_pf", () => {
		const parsed = clientOrderSchema.safeParse(third({ partners: [partner] }));
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((i) => i.message)).toContain("Sócios só no Dossiê Empresarial.");
	});

	it("accepts up to 20 partners on dossie_empresarial and refuses 21", () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...partner, email: `socio${i}@example.test` }));
		const ok = clientOrderSchema.safeParse(company({ partners: many(MAX_PARTNERS) }));
		expect(ok.success).toBe(true);
		if (ok.success) expect(ok.data.partners[0]).toEqual({ documentDigits: CPF_DIGITS, name: "Sócio Um", email: "socio0@example.test", percentage: 50, role: "Sócio" });
		expect(clientOrderSchema.safeParse(company({ partners: many(MAX_PARTNERS + 1) })).success).toBe(false);
	});

	it("names the people limit in the message", () => {
		const many = Array.from({ length: MAX_PARTNERS + 1 }, (_, i) => ({ ...partner, email: `socio${i}@example.test` }));
		const parsed = clientOrderSchema.safeParse(company({ partners: many }));
		expect(parsed.error?.issues.map((i) => i.message)).toContain("No máximo 20 pessoas.");
	});

	it("refuses two partners with the same e-mail, ignoring case and spaces", () => {
		const other = { ...partner, name: "Sócio Dois", document: "111.444.777-35", email: "  SOCIO@Example.test " };
		const parsed = clientOrderSchema.safeParse(company({ partners: [partner, other] }));
		expect(parsed.success).toBe(false);
		const issue = parsed.error?.issues.find((i) => i.path.join(".") === "partners.1.email");
		expect(issue?.message).toBe("Cada pessoa precisa de um e-mail próprio.");
	});

	it("accepts the same CPF twice and counts one partner", () => {
		const again = { ...partner, email: "outro@example.test" };
		const parsed = clientOrderSchema.safeParse(company({ partners: [partner, again] }));
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.partners).toHaveLength(1);
	});

	it("refuses a CNPJ as partner and keeps the declaration flag", () => {
		expect(clientOrderSchema.safeParse(company({ partners: [{ ...partner, document: CNPJ }] })).success).toBe(false);
		const parsed = clientOrderSchema.safeParse(company({ declarationAccepted: true }));
		expect(parsed.success && parsed.data.declarationAccepted).toBe(true);
	});
});

describe("counterOrderSchema", () => {
	const base = (over: Record<string, unknown> = {}) => ({
		productCode: "dossie_empresarial",
		buyerProfileId: null,
		subject: { name: "Empresa Ltda", document: CNPJ },
		...over,
	});

	it("accepts partners only for dossie_empresarial", () => {
		const partner = { document: CPF, name: "Sócio Um", email: "socio@example.test", percentage: 50, role: "Sócio" };
		const full = counterOrderSchema.safeParse(base({ productCode: "dossie_empresarial", partners: [partner] }));
		expect(full.success).toBe(true);
		if (full.success) {
			expect(full.data.partners).toEqual([{ documentDigits: CPF_DIGITS, name: "Sócio Um", email: "socio@example.test", percentage: 50, role: "Sócio" }]);
			expect(full.data.subject).toEqual({ type: "PJ", name: "Empresa Ltda", documentDigits: CNPJ_DIGITS });
		}
		expect(counterOrderSchema.safeParse(base({ productCode: "dossie_pf", subject: { name: "Maria", document: CPF }, partners: [partner] })).success).toBe(false);
	});

	it("requires a valid e-mail for each partner", () => {
		const partner = { document: CPF, name: "Sócio Um" };
		const refuse = (email: unknown) =>
			counterOrderSchema.safeParse(base({ productCode: "dossie_empresarial", partners: [{ ...partner, email }] })).success;
		expect(refuse(undefined)).toBe(false);
		expect(refuse("")).toBe(false);
		expect(refuse("sem-arroba")).toBe(false);
		expect(refuse("socio@example.test")).toBe(true);
	});

	it("refuses an invalid partner CPF, more than 20 partners and a bad buyer id", () => {
		const bad = { document: "111.111.111-11", name: "Sócio", email: "socio@example.test" };
		expect(counterOrderSchema.safeParse(base({ productCode: "dossie_empresarial", partners: [bad] })).success).toBe(false);
		const many = Array.from({ length: 21 }, () => ({ document: CPF, name: "Sócio", email: "socio@example.test" }));
		expect(counterOrderSchema.safeParse(base({ productCode: "dossie_empresarial", partners: many })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ buyerProfileId: "x" })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ buyerProfileId: UUID })).success).toBe(true);
	});

	it("needs a subject and checks the document kind by product", () => {
		expect(counterOrderSchema.safeParse(base({ subject: undefined })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ subject: { name: "Maria", document: CPF } })).success).toBe(false);
		expect(counterOrderSchema.safeParse(base({ productCode: "dossie_pf", subject: { name: "Maria", document: CPF } })).success).toBe(true);
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

describe("updateOrderContactSchema", () => {
	const base = { dossierId: UUID, consultationId: UUID };

	it("treats blank contact as null (resend to the current contact)", () => {
		expect(updateOrderContactSchema.parse({ ...base, contactEmail: "  ", contactPhone: "" })).toMatchObject({
			contactEmail: null,
			contactPhone: null,
		});
	});

	it("checks the ids and the e-mail format", () => {
		expect(updateOrderContactSchema.safeParse({ ...base, consultationId: "abc" }).success).toBe(false);
		expect(updateOrderContactSchema.safeParse({ ...base, contactEmail: "sem-arroba" }).success).toBe(false);
		expect(updateOrderContactSchema.parse({ ...base, contactEmail: " novo@example.test " }).contactEmail).toBe("novo@example.test");
	});
});

describe("counterOrderSchema without contact", () => {
	it("accepts no contact: the server decides when the subject is the buyer's own holder", () => {
		const parsed = counterOrderSchema.parse({
			productCode: "dossie_pf",
			subject: { name: "Maria", document: CPF },
			contactEmail: "",
			contactPhone: "",
		});
		expect(parsed).toMatchObject({ contactEmail: null, contactPhone: null });
	});
});

describe("duplicateEmailIndexes", () => {
	it("finds repeated e-mails ignoring case and spaces", () => {
		expect(duplicateEmailIndexes([{ email: "a@b.co" }, { email: "x@b.co" }, { email: " A@B.co " }])).toEqual([2]);
	});

	it("ignores rows without e-mail and an empty list", () => {
		expect(duplicateEmailIndexes([{ email: "" }, {}, { email: "  " }])).toEqual([]);
		expect(duplicateEmailIndexes([])).toEqual([]);
	});

	it("does not treat a repeated CPF with different e-mails as a repeat", () => {
		const row = { document: "529.982.247-25" };
		expect(duplicateEmailIndexes([{ ...row, email: "a@b.co" }, { ...row, email: "c@b.co" }])).toEqual([]);
	});
});
