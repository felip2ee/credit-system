// Migration 018: índices das telas de cobrança/NFS-e e limpeza dos índices sem consulta. Confere o catálogo
// (pg_indexes), não o plano do EXPLAIN, que muda com as estatísticas.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });

afterAll(async () => {
	await owner.end();
});

async function indexdef(name: string): Promise<string | undefined> {
	const { rows } = await owner.query<{ indexdef: string }>(
		"select indexdef from pg_indexes where schemaname = 'public' and indexname = $1",
		[name],
	);
	return rows[0]?.indexdef;
}

describe("índices de pix_charges", () => {
	it("indexes the Bureau's own charges by Bureau and date, only where the client is null", async () => {
		const def = await indexdef("pix_charges_bureau_own_created_idx");
		expect(def).toMatch(/ON public\.pix_charges USING btree \(bureau_id, created_at DESC\)/);
		expect(def).toMatch(/WHERE \(client_profile_id IS NULL\)/);
	});

	it("indexes the unrecovered refunds by Bureau and date, only where refund_shortfall > 0", async () => {
		const def = await indexdef("pix_charges_shortfall_idx");
		expect(def).toMatch(/ON public\.pix_charges USING btree \(bureau_id, created_at DESC\)/);
		expect(def).toMatch(/WHERE \(refund_shortfall > \(0\)::numeric\)/);
	});

	it("indexes the failed invoices in the order of list_failed_nfse, only where nfse_status = 'failed'", async () => {
		const def = await indexdef("pix_charges_nfse_failed_idx");
		expect(def).toMatch(/USING btree \(nfse_updated_at DESC NULLS LAST, id\)/);
		expect(def).toMatch(/WHERE \(nfse_status = 'failed'::text\)/);
	});
});

describe("índices sem consulta", () => {
	it("drops the four indexes no query used", async () => {
		for (const name of [
			"client_ledger_entries_bureau_idx",
			"order_settlements_bureau_created_idx",
			"order_settlements_client_idx",
			"payout_items_bureau_idx",
		]) {
			expect(await indexdef(name), name).toBeUndefined();
		}
	});
});
