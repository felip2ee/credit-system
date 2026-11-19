// O cálculo em TypeScript tem de dar o mesmo resultado que o de reserve_order (049): round(preço * valor / 100, 2) e
// least(valor, preço). Aqui o SQL roda com os mesmos números, em reais, e o resultado vira centavos.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

import { computeCouponDiscount } from "./discount";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });

afterAll(() => owner.end());

async function sqlDiscountCents(kind: "percent" | "fixed", value: string, baseCents: number): Promise<number> {
	const price = (baseCents / 100).toFixed(2);
	const { rows } = await owner.query<{ cents: string }>(
		`select ((case $1::text when 'percent' then round($2::numeric * $3::numeric / 100, 2)
		                        else least($3::numeric, $2::numeric) end) * 100)::bigint::text as cents`,
		[kind, price, value],
	);
	return Number(rows[0].cents);
}

describe("computeCouponDiscount equals the SQL discount", () => {
	const bases = [0, 1, 4, 5, 99, 3333, 5000, 14000, 123_457, 9_999_999_999];
	const percents = ["0.01", "10", "12.5", "33.33", "50", "99.99", "100"];
	const fixed = ["0.01", "12.5", "50", "80", "99999999.99"];

	it.each(bases)("percent over %i cents", async (base) => {
		for (const pct of percents) {
			expect(computeCouponDiscount({ kind: "percent", value: Number(pct), eligibleTotalCents: base }).discountCents).toBe(
				await sqlDiscountCents("percent", pct, base),
			);
		}
	});

	it.each(bases)("fixed over %i cents", async (base) => {
		for (const value of fixed) {
			expect(computeCouponDiscount({ kind: "fixed", value: Number(value), eligibleTotalCents: base }).discountCents).toBe(
				await sqlDiscountCents("fixed", value, base),
			);
		}
	});
});
