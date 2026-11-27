import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system_test",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
	});
});
vi.mock("next/headers", () => ({ headers: () => ({ get: () => null }) }));

import { SplitOver100Error } from "./queries";
import { buildSplitPlan, toSplitPlan } from "./split-plan";

const row = (over: Partial<Parameters<typeof toSplitPlan>[0][number]>) => ({
	beneficiary_kind: "partner" as const,
	beneficiary_id: "id-1",
	payout_method: "asaas" as const,
	asaas_wallet_id: "wallet-1",
	pct: "10.50",
	amount_cents: "1050",
	...over,
});

describe("toSplitPlan", () => {
	it("separa split do Asaas, linhas em modo Pix e accrual de bureau, com percentual em número", () => {
		const plan = toSplitPlan([
			row({}),
			row({ beneficiary_kind: "affiliate", beneficiary_id: "aff", payout_method: "pix", asaas_wallet_id: null, pct: "7.00", amount_cents: "700" }),
			row({ beneficiary_kind: "bureau", beneficiary_id: "b", payout_method: "accrual", asaas_wallet_id: null, pct: "20.00", amount_cents: "2000" }),
		]);

		expect(plan.asaasSplit).toEqual([{ walletId: "wallet-1", percentualValue: 10.5 }]);
		expect(plan.pixLines).toEqual([{ kind: "affiliate", beneficiaryId: "aff", payoutMethod: "pix", walletId: null, pct: 7, amountCents: 700 }]);
		expect(plan.accrualLines).toEqual([{ kind: "bureau", beneficiaryId: "b", payoutMethod: "accrual", walletId: null, pct: 20, amountCents: 2000 }]);
	});

	it("a segunda tentativa tira só o item do afiliado", () => {
		const plan = toSplitPlan([row({}), row({ beneficiary_kind: "affiliate", beneficiary_id: "aff", asaas_wallet_id: "wallet-aff" })]);

		expect(plan.asaasSplit.map((i) => i.walletId)).toEqual(["wallet-1", "wallet-aff"]);
		expect(plan.asaasSplitWithoutAffiliate.map((i) => i.walletId)).toEqual(["wallet-1"]);
	});

	it("plano vazio não leva split ao Asaas", () => {
		expect(toSplitPlan([])).toEqual({ asaasSplit: [], asaasSplitWithoutAffiliate: [], pixLines: [], accrualLines: [] });
	});
});

describe("buildSplitPlan", () => {
	it("traduz o erro split_over_100 do banco em SplitOver100Error", async () => {
		const client = { query: async () => { throw new Error("split_over_100"); } };
		await expect(buildSplitPlan(client as never, "charge")).rejects.toBeInstanceOf(SplitOver100Error);
	});

	it("outro erro do banco sobe como está", async () => {
		const client = { query: async () => { throw new Error("not_allowed"); } };
		await expect(buildSplitPlan(client as never, "charge")).rejects.toThrow("not_allowed");
	});
});
