import { describe, expect, it } from "vitest";

import { couponActiveSchema, couponCreateSchema, couponUpdateSchema } from "./coupons";

const base = {
	code: "demo-10",
	kind: "percent" as const,
	value: "10",
	allProducts: true,
	productCodes: [],
	maxUses: null,
	maxUsesPerClient: null,
};

const issue = (input: unknown) => {
	const r = couponCreateSchema.safeParse(input);
	return r.success ? null : r.error.issues[0];
};

describe("couponCreateSchema", () => {
	it("normaliza o código (trim + maiúsculas)", () => {
		const r = couponCreateSchema.parse({ ...base, code: "  demo-1_x " });
		expect(r.code).toBe("DEMO-1_X");
		expect(r.validFrom).toBeNull();
		expect(r.validUntil).toBeNull();
	});

	it.each(["ab", "abcde", "a".repeat(33), "com espaço", "açaí", ""])("recusa o código %j", (code) => {
		expect(issue({ ...base, code })?.path).toEqual(["code"]);
	});

	it.each(["abcdef", "a".repeat(32)])("aceita o código de borda %j", (code) => {
		expect(issue({ ...base, code })).toBeNull();
	});

	it("limite por cliente: padrão 1 só com limite total e campo ausente", () => {
		const { maxUsesPerClient: _omit, ...absent } = base;
		const parse = (input: object) => couponCreateSchema.parse(input).maxUsesPerClient;
		expect(parse({ ...absent, maxUses: 10 })).toBe(1);
		expect(parse({ ...absent, maxUses: null })).toBeNull();
		expect(parse({ ...base, maxUses: 10, maxUsesPerClient: null })).toBeNull();
		expect(parse({ ...base, maxUses: 10, maxUsesPerClient: 3 })).toBe(3);
		expect(couponUpdateSchema.parse({ ...absent, id: crypto.randomUUID(), maxUses: 10 }).maxUsesPerClient).toBe(1);
	});

	it.each(["0.01", "100", "99.99", "0.5"])("aceita percentual %s", (value) => {
		expect(issue({ ...base, value })).toBeNull();
	});

	it.each(["0", "0.00", "0.001", "100.01", "-1", "abc", ""])("recusa percentual %j", (value) => {
		expect(issue({ ...base, value })?.path).toEqual(["value"]);
	});

	it("fixo: maior que zero e até 99999999.99", () => {
		expect(issue({ ...base, kind: "fixed", value: "0.01" })).toBeNull();
		expect(issue({ ...base, kind: "fixed", value: "250.00" })).toBeNull();
		expect(issue({ ...base, kind: "fixed", value: "99999999.99" })).toBeNull();
		expect(issue({ ...base, kind: "fixed", value: "0" })?.path).toEqual(["value"]);
		expect(issue({ ...base, kind: "fixed", value: "100000000" })?.path).toEqual(["value"]);
	});

	it("produto específico exige ao menos um produto", () => {
		expect(issue({ ...base, allProducts: false, productCodes: [] })?.path).toEqual(["productCodes"]);
		expect(issue({ ...base, allProducts: false, productCodes: ["dossie_pf"] })).toBeNull();
		expect(issue({ ...base, allProducts: false, productCodes: ["outro"] })?.path[0]).toBe("productCodes");
	});

	it("valid_until deve ser depois de valid_from", () => {
		const from = "2026-01-10T00:00:00.000Z";
		expect(issue({ ...base, validFrom: from, validUntil: from })?.path).toEqual(["validUntil"]);
		expect(issue({ ...base, validFrom: from, validUntil: "2026-01-09T00:00:00.000Z" })?.path).toEqual(["validUntil"]);
		expect(issue({ ...base, validFrom: from, validUntil: "2026-01-10T00:00:01.000Z" })).toBeNull();
	});

	it("limites: nulos ou inteiros positivos", () => {
		expect(issue({ ...base, maxUses: 1, maxUsesPerClient: 5 })).toBeNull();
		for (const bad of [0, -1, 1.5]) {
			expect(issue({ ...base, maxUses: bad })?.path).toEqual(["maxUses"]);
			expect(issue({ ...base, maxUsesPerClient: bad })?.path).toEqual(["maxUsesPerClient"]);
		}
	});
});

describe("couponUpdateSchema e couponActiveSchema", () => {
	it("exige id uuid", () => {
		expect(couponUpdateSchema.safeParse({ ...base, id: "x" }).success).toBe(false);
		expect(couponUpdateSchema.safeParse({ ...base, id: crypto.randomUUID() }).success).toBe(true);
		expect(couponActiveSchema.safeParse({ id: "x", active: false }).success).toBe(false);
		expect(couponActiveSchema.safeParse({ id: crypto.randomUUID(), active: false }).success).toBe(true);
	});
});
