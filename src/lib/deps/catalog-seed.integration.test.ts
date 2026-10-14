import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "./products";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 1 });

afterAll(() => owner.end());

describe("seed do catálogo x src/lib/deps/products.ts", () => {
	it("keeps the DEPS names of version 1 equal to the code constants", async () => {
		const { rows } = await owner.query<{ code: string; deps_product: string | null }>(
			`select p.code, v.deps_product
         from products p join product_versions v on v.product_id = p.id and v.version = 1
        where p.code in ('consulta_pf', 'consulta_pj', 'dossie_pj_completo', 'parecer_ia')`,
		);
		const names = Object.fromEntries(rows.map((r) => [r.code, r.deps_product]));

		expect(names).toEqual({
			consulta_pf: DEPS_PRODUCT_PF,
			consulta_pj: DEPS_PRODUCT_PJ,
			dossie_pj_completo: DEPS_PRODUCT_PJ,
			parecer_ia: null,
		});
	});
});
