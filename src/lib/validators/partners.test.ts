import { describe, expect, it } from "vitest";

import { bureauWalletSchema, partnerSchema } from "./partners";

const ok = { name: "Sócio", asaasWalletId: "11111111-2222-3333-4444-555555555555", pct: "10", active: true };
const BUREAU = "99999999-9999-4999-8999-999999999999";

describe("partnerSchema", () => {
	it("aceita 0.01 a 100 com até 2 casas", () => {
		for (const pct of ["0.01", "10", "33.33", "100"]) expect(partnerSchema.safeParse({ ...ok, pct }).success).toBe(true);
	});
	it("recusa pct 0, acima de 100, negativo, texto e 3 casas", () => {
		for (const pct of ["0", "0.00", "100.01", "101", "-5", "abc", "1.234", ""]) {
			expect(partnerSchema.safeParse({ ...ok, pct }).success).toBe(false);
		}
	});
	it("recusa nome vazio e walletId inválido", () => {
		expect(partnerSchema.safeParse({ ...ok, name: "  " }).success).toBe(false);
		expect(partnerSchema.safeParse({ ...ok, asaasWalletId: "" }).success).toBe(false);
		expect(partnerSchema.safeParse({ ...ok, asaasWalletId: "a b; drop" }).success).toBe(false);
	});
	it("walletId é um UUID, o mesmo formato do afiliado: um texto qualquer de 8 a 64 caracteres é recusado", () => {
		for (const asaasWalletId of ["abcd1234", "abcdefgh-ijkl", "11111111-2222-3333-4444-55555555555", "x".repeat(36)]) {
			expect(partnerSchema.safeParse({ ...ok, asaasWalletId }).success).toBe(false);
			expect(bureauWalletSchema.safeParse({ bureauId: BUREAU, asaasWalletId }).success).toBe(false);
		}
		const upper = partnerSchema.safeParse({ ...ok, asaasWalletId: "  AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE " });
		expect(upper.success && upper.data.asaasWalletId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
	});
});

describe("bureauWalletSchema", () => {
	it("aceita walletId; recusa vazio e bureau inválido", () => {
		expect(bureauWalletSchema.safeParse({ bureauId: BUREAU, asaasWalletId: ok.asaasWalletId }).success).toBe(true);
		expect(bureauWalletSchema.safeParse({ bureauId: BUREAU, asaasWalletId: "  " }).success).toBe(false);
		expect(bureauWalletSchema.safeParse({ bureauId: "x", asaasWalletId: ok.asaasWalletId }).success).toBe(false);
	});
});
