import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "./products";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 1 });

afterAll(() => owner.end());

describe("seed do catálogo x src/lib/deps/products.ts", () => {
	it("has only the two dossier products from the seed, with DEPS names equal to the code constants", async () => {
		const { rows } = await owner.query<{
			code: string;
			deps_product: string | null;
			base_cost: string;
			base_cost_per_partner: string;
		}>(
			`select p.code, v.deps_product, v.base_cost, v.base_cost_per_partner
         from products p join product_versions v on v.product_id = p.id and v.version = 1
        where p.code in ('dossie_pf', 'dossie_empresarial', 'consulta_pf', 'consulta_pj', 'dossie_pj_completo', 'parecer_ia')
        order by p.code`,
		);

		expect(rows).toEqual([
			{ code: "dossie_empresarial", deps_product: DEPS_PRODUCT_PJ, base_cost: "0.00", base_cost_per_partner: "0.00" },
			{ code: "dossie_pf", deps_product: DEPS_PRODUCT_PF, base_cost: "0.00", base_cost_per_partner: "0.00" },
		]);
	});
});
