// Sócios e walletId do bureau contra um Postgres real: só o superadmin escreve, teto de 100% e walletId mascarado na auditoria.
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { setBureauCommissionOverride } from "@/lib/commission/queries";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSupportSession, seedSuperadmin, seedTenant, type SeedSuperadmin } from "@/test/seed";

import { getBureauWalletId, listPartners, setBureauWalletId, upsertPartner } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const WALLET_A = "11111111-2222-3333-4444-555555555555";
const WALLET_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let SA: SeedSuperadmin;

// upsertPartner soma a configuração de todos os bureaus (assertSplitWithin100): apaga as sobras das suítes anteriores.
// Seguro porque os arquivos rodam um por vez (fileParallelism: false). replica: bureau_commission_rates é append-only.
beforeAll(async () => {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query("delete from bureau_commission_rates");
		await client.query("delete from bureau_referrals");
		await client.query("delete from bureau_affiliate_settings");
		await client.query("delete from settings where key = 'bureau_commission_pct'");
		await client.query("delete from platform_partners");
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
	SA = await seedSuperadmin(owner);
});

// A soma dos sócios é global: cada teste começa sem sócios.
afterEach(async () => {
	await owner.query("delete from platform_partners");
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const partner = (over: Partial<Parameters<typeof upsertPartner>[1]> = {}) => ({
	name: "Sócio Um",
	asaasWalletId: WALLET_A,
	pct: "10",
	active: true,
	...over,
});

describe("sócios", () => {
	it("superadmin cria, edita e lista; a auditoria guarda o walletId mascarado", async () => {
		const created = await upsertPartner(SA, partner());
		expect(created).toEqual({ error: null, id: expect.any(String) });
		const id = (created as { id: string }).id;
		await expect(upsertPartner(SA, partner({ id, name: "Sócio Um Editado", pct: "12.5" }))).resolves.toEqual({ error: null, id });

		const rows = await listPartners(SA);
		expect(rows).toEqual([{ id, name: "Sócio Um Editado", asaasWalletId: WALLET_A, pct: "12.50", active: true }]);

		const audit = await owner.query<{ action: string; metadata: unknown }>(
			"select action, metadata from audit_logs where record_id = $1 order by created_at",
			[id],
		);
		expect(audit.rows.map((r) => r.action)).toEqual(["partner.upsert", "partner.upsert"]);
		const serialized = JSON.stringify(audit.rows);
		expect(serialized).not.toContain(WALLET_A);
		expect(serialized).toContain("***5555");
	});

	it("editar um id que não existe falha sem criar linha", async () => {
		const result = await upsertPartner(SA, partner({ id: "99999999-9999-4999-8999-999999999999" }));
		expect(result.error).toBe("Sócio não encontrado.");
		expect(await listPartners(SA)).toEqual([]);
	});

	it("soma de sócios ativos acima de 100% é recusada; inativo não conta", async () => {
		await upsertPartner(SA, partner({ pct: "60" }));
		const over = await upsertPartner(SA, partner({ name: "Sócio Dois", asaasWalletId: WALLET_B, pct: "50" }));
		expect(over.error).toMatch(/100%/);
		expect(await listPartners(SA)).toHaveLength(1);

		await expect(upsertPartner(SA, partner({ name: "Sócio Dois", asaasWalletId: WALLET_B, pct: "50", active: false }))).resolves.toMatchObject({
			error: null,
		});
	});

	it("sócios mais a % do bureau acima de 100% são recusados", async () => {
		const T = await seedTenant(owner, "Partner split");
		await setBureauCommissionOverride(SA, T.bureau.id, 70);
		const over = await upsertPartner(SA, partner({ pct: "40" }));
		expect(over.error).toMatch(/100%/);
		await expect(upsertPartner(SA, partner({ pct: "30" }))).resolves.toMatchObject({ error: null });
		// bureau_commission_rates é imutável: volta o override ao global (sem % global = 0) para não vazar nos outros testes.
		await setBureauCommissionOverride(SA, T.bureau.id, null);
	});

	it("só o superadmin: bureau_admin não lê nem grava (RLS)", async () => {
		await upsertPartner(SA, partner());
		const T = await seedTenant(owner, "Partner rls");
		expect(await listPartners(T.bureauAdmin)).toEqual([]);
		await expect(upsertPartner(T.bureauAdmin, partner({ name: "Intruso" }))).rejects.toThrow(/row-level security|permission denied/);
		const { rows } = await owner.query("select 1 from platform_partners");
		expect(rows).toHaveLength(1);
	});

	it("sessão de suporte não grava", async () => {
		const T = await seedTenant(owner, "Partner support");
		const session = await seedSupportSession(owner, { superadminId: SA.userId, bureauId: T.bureau.id });
		const inSupport = { ...SA, bureauId: T.bureau.id, supportSessionId: session };
		await expect(upsertPartner(inSupport, partner())).rejects.toThrow(/row-level security|permission denied/);
	});
});

describe("walletId do bureau", () => {
	it("superadmin grava e atualiza; auditoria mascarada", async () => {
		const T = await seedTenant(owner, "Wallet bureau");
		await expect(getBureauWalletId(SA, T.bureau.id)).resolves.toBeNull();

		await expect(setBureauWalletId(SA, { bureauId: T.bureau.id, asaasWalletId: WALLET_A })).resolves.toEqual({ error: null });
		await expect(setBureauWalletId(SA, { bureauId: T.bureau.id, asaasWalletId: WALLET_B })).resolves.toEqual({ error: null });
		await expect(getBureauWalletId(SA, T.bureau.id)).resolves.toBe(WALLET_B);
		const saved = await owner.query<{ updated_by: string }>("select updated_by from bureau_asaas_wallets where bureau_id = $1", [T.bureau.id]);
		expect(saved.rows[0].updated_by).toBe(SA.userId);


		const audit = await owner.query<{ action: string; metadata: unknown }>(
			"select action, metadata from audit_logs where record_id = $1 order by created_at",
			[T.bureau.id],
		);
		expect(audit.rows.map((r) => r.action)).toEqual(["bureau_wallet.set", "bureau_wallet.set"]);
		const serialized = JSON.stringify(audit.rows);
		expect(serialized).not.toContain(WALLET_A);
		expect(serialized).not.toContain(WALLET_B);
	});

	it("bureau inexistente: erro sem lançar", async () => {
		const result = await setBureauWalletId(SA, { bureauId: "99999999-9999-4999-8999-999999999999", asaasWalletId: WALLET_A });
		expect(result.error).toBe("Bureau não encontrado.");
	});

	it("bureau_admin e cliente não gravam; equipe lê só o próprio", async () => {
		const A = await seedTenant(owner, "Wallet A");
		const B = await seedTenant(owner, "Wallet B");
		await setBureauWalletId(SA, { bureauId: A.bureau.id, asaasWalletId: WALLET_A });
		await expect(setBureauWalletId(A.bureauAdmin, { bureauId: A.bureau.id, asaasWalletId: WALLET_B })).rejects.toThrow(
			/row-level security|permission denied/,
		);
		await expect(setBureauWalletId(A.client, { bureauId: A.bureau.id, asaasWalletId: WALLET_B })).rejects.toThrow(
			/row-level security|permission denied/,
		);
		await expect(getBureauWalletId(A.bureauAdmin, A.bureau.id)).resolves.toBe(WALLET_A);
		await expect(getBureauWalletId(B.bureauAdmin, A.bureau.id)).resolves.toBeNull();
		await expect(getBureauWalletId(A.client, A.bureau.id)).resolves.toBeNull();
	});

	it("RLS esconde sócios da equipe do bureau", async () => {
		await upsertPartner(SA, partner());
		const T = await seedTenant(owner, "Hide partners");
		const { rows } = await withUserTransaction(T.bureauAdmin, (c) => c.query("select 1 from platform_partners"));
		expect(rows).toHaveLength(0);
	});
});
