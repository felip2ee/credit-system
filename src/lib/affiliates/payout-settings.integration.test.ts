// Configurar pagamentos do afiliado (066) contra um Postgres real: modo, walletId, quem pode mudar e auditoria sem walletId.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedSuperadmin, seedSupportSession, seedTenant, type SeededTenant, type SeedSuperadmin } from "@/test/seed";

import { getPayoutSettings, maskWalletId, setPayoutMethod } from "./payout-settings";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let A: SeededTenant;
let B: SeededTenant;
let SA: SeedSuperadmin;

beforeAll(async () => {
	[A, B, SA] = await Promise.all([seedTenant(owner, "Payout A"), seedTenant(owner, "Payout B"), seedSuperadmin(owner)]);
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const stored = async (profileId: string) =>
	(await owner.query<{ payout_method: string; asaas_wallet_id: string | null }>(
		"select payout_method, asaas_wallet_id from affiliate_wallets where profile_id = $1",
		[profileId],
	)).rows[0];

describe("setPayoutMethod", () => {
	it("defaults to pix", async () => {
		expect(await getPayoutSettings(A.client, A.client.userId)).toEqual({ method: "pix", walletIdMasked: null });
	});

	it("refuses asaas without walletId or with an invalid one", async () => {
		const owner_ = { profileId: A.client.userId };
		expect((await setPayoutMethod(A.client, { owner: owner_, method: "asaas" })).error).toMatch(/walletId/);
		expect((await setPayoutMethod(A.client, { owner: owner_, method: "asaas", asaasWalletId: "  " })).error).toMatch(/walletId/);
		expect((await setPayoutMethod(A.client, { owner: owner_, method: "asaas", asaasWalletId: "abc" })).error).toMatch(/walletId/);
		expect((await stored(A.client.userId)).payout_method).toBe("pix");
	});

	it("saves asaas, audits without the full walletId, and keeps it when going back to pix", async () => {
		const walletId = randomUUID();
		const res = await setPayoutMethod(A.client, { owner: { profileId: A.client.userId }, method: "asaas", asaasWalletId: walletId.toUpperCase() });
		expect(res.error).toBeNull();
		expect(await stored(A.client.userId)).toEqual({ payout_method: "asaas", asaas_wallet_id: walletId });
		expect(await getPayoutSettings(A.client, A.client.userId)).toEqual({ method: "asaas", walletIdMasked: maskWalletId(walletId) });

		const audit = await owner.query<{ metadata: Record<string, unknown> }>(
			"select metadata from audit_logs where action = 'affiliate.payout_method' and record_id = $1 order by created_at desc limit 1",
			[A.client.userId],
		);
		expect(audit.rows[0].metadata).toMatchObject({ from: "pix", to: "asaas", on_behalf: false, wallet_masked: maskWalletId(walletId) });
		expect(JSON.stringify(audit.rows[0].metadata)).not.toContain(walletId);

		expect((await setPayoutMethod(A.client, { owner: { profileId: A.client.userId }, method: "pix" })).error).toBeNull();
		expect(await stored(A.client.userId)).toEqual({ payout_method: "pix", asaas_wallet_id: walletId });
		// Voltar para asaas sem digitar de novo reaproveita o walletId salvo.
		expect((await setPayoutMethod(A.client, { owner: { profileId: A.client.userId }, method: "asaas" })).error).toBeNull();
		expect((await stored(A.client.userId)).payout_method).toBe("asaas");
	});

	it("lets the bureau_admin set the walletId of own affiliate, not of another bureau's", async () => {
		const mine = await seedClientProfile(owner, A.bureau.id);
		const theirs = await seedClientProfile(owner, B.bureau.id);
		const walletId = randomUUID();

		expect((await setPayoutMethod(A.bureauAdmin, { owner: { profileId: mine.userId }, method: "asaas", asaasWalletId: walletId })).error).toBeNull();
		expect(await stored(mine.userId)).toEqual({ payout_method: "asaas", asaas_wallet_id: walletId });
		const audit = await owner.query<{ metadata: { on_behalf: boolean } }>(
			"select metadata from audit_logs where action = 'affiliate.payout_method' and record_id = $1",
			[mine.userId],
		);
		expect(audit.rows[0].metadata.on_behalf).toBe(true);

		const res = await setPayoutMethod(A.bureauAdmin, { owner: { profileId: theirs.userId }, method: "asaas", asaasWalletId: walletId });
		expect(res.error).toBe("Afiliado não encontrado.");
		expect((await stored(theirs.userId)).payout_method).toBe("pix");
		expect(await getPayoutSettings(A.bureauAdmin, theirs.userId)).toBeNull();
	});

	it("refuses a client editing another affiliate and an operator", async () => {
		const other = await seedClientProfile(owner, A.bureau.id);
		const walletId = randomUUID();
		expect((await setPayoutMethod(A.client, { owner: { profileId: other.userId }, method: "asaas", asaasWalletId: walletId })).error).toMatch(/permissão/);
		expect((await setPayoutMethod(A.operator, { owner: { profileId: other.userId }, method: "asaas", asaasWalletId: walletId })).error).toMatch(/permissão/);
		expect((await stored(other.userId)).payout_method).toBe("pix");
	});

	it("lets the superadmin edit, but not inside a support session", async () => {
		const target = await seedClientProfile(owner, B.bureau.id);
		const walletId = randomUUID();
		expect((await setPayoutMethod(SA, { owner: { profileId: target.userId }, method: "asaas", asaasWalletId: walletId })).error).toBeNull();
		expect((await stored(target.userId)).asaas_wallet_id).toBe(walletId);

		const support = await seedSupportSession(owner, { superadminId: SA.userId, bureauId: B.bureau.id });
		const res = await setPayoutMethod({ ...SA, bureauId: B.bureau.id, supportSessionId: support }, { owner: { profileId: target.userId }, method: "pix" });
		expect(res.error).toMatch(/permissão/);
		expect((await stored(target.userId)).payout_method).toBe("asaas");
	});

	const notices = async (profileId: string) =>
		(
			await owner.query<{ recipient: string; email: string; params: Record<string, string>; email_text: string; bureau_id: string }>(
				`select n.recipient, p.email, n.params, t.email_text, n.bureau_id
				   from notifications n
				   join notification_templates t on t.id = n.template_id
				   join profiles p on p.id = $1::uuid
				  where t.key = 'affiliate_payout_changed' and n.reference = 'affiliate_payout:' || $1::text
				  order by n.created_at`,
				[profileId],
			)
		).rows;

	it("queues an e-mail to the affiliate for each change, with the masked walletId and who changed it", async () => {
		const affiliate = await seedClientProfile(owner, A.bureau.id);
		const target = { profileId: affiliate.userId };
		const [first, second] = [randomUUID(), randomUUID()];

		await setPayoutMethod(affiliate, { owner: target, method: "asaas", asaasWalletId: first });
		await setPayoutMethod(A.bureauAdmin, { owner: target, method: "asaas", asaasWalletId: second });
		await setPayoutMethod(SA, { owner: target, method: "pix" });
		// Salvar o mesmo valor não é mudança: sem aviso.
		await setPayoutMethod(affiliate, { owner: target, method: "pix", asaasWalletId: second });

		const sent = await notices(affiliate.userId);
		expect(sent.map((n) => [n.params.actor, n.params.method, n.params.wallet])).toEqual([
			["você", "Conta Asaas", maskWalletId(first)],
			["a equipe do bureau", "Conta Asaas", maskWalletId(second)],
			["a equipe do bureau", "Chave Pix", maskWalletId(second)],
		]);
		for (const n of sent) {
			expect(n.recipient).toBe(n.email.toLowerCase());
			expect(n.bureau_id).toBe(A.bureau.id);
			expect(JSON.stringify(n.params)).not.toContain(first);
			expect(JSON.stringify(n.params)).not.toContain(second);
		}
		expect(sent[0].email_text).toMatch(/não esperava esta mudança, fale com o seu bureau/);

		const audit = await owner.query<{ metadata: { wallet_before: string | null; wallet_masked: string | null } }>(
			"select metadata from audit_logs where action = 'affiliate.payout_method' and record_id = $1 order by created_at",
			[affiliate.userId],
		);
		expect(audit.rows.slice(0, 2).map((r) => [r.metadata.wallet_before, r.metadata.wallet_masked])).toEqual([
			[null, maskWalletId(first)],
			[maskWalletId(first), maskWalletId(second)],
		]);
	});

	it("queues nothing when the change is refused or rolled back", async () => {
		const affiliate = await seedClientProfile(owner, A.bureau.id);
		await setPayoutMethod(B.bureauAdmin, { owner: { profileId: affiliate.userId }, method: "asaas", asaasWalletId: randomUUID() });
		await expect(
			withUserTransaction(affiliate, async (c) => {
				await c.query("update affiliate_wallets set asaas_wallet_id = $2 where profile_id = $1", [affiliate.userId, randomUUID()]);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await notices(affiliate.userId)).toEqual([]);
	});

	it("refuses the walletId of a partner or of a bureau, with a generic message", async () => {
		const affiliate = await seedClientProfile(owner, A.bureau.id);
		const [partnerWallet, bureauWallet] = [randomUUID(), randomUUID()];
		await owner.query("insert into platform_partners (name, asaas_wallet_id, pct, active) values ('Sócio Colisão', $1, 0.01, false)", [partnerWallet]);
		await owner.query("insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id) values ($1, $2)", [B.bureau.id, bureauWallet]);
		try {
			for (const taken of [partnerWallet, bureauWallet.toUpperCase()]) {
				for (const identity of [affiliate, A.bureauAdmin]) {
					const res = await setPayoutMethod(identity, { owner: { profileId: affiliate.userId }, method: "asaas", asaasWalletId: taken });
					expect(res.error).toBe("Este walletId não pode ser usado. Informe o walletId da conta do afiliado.");
				}
			}
			expect(await stored(affiliate.userId)).toEqual({ payout_method: "pix", asaas_wallet_id: null });
			expect(await notices(affiliate.userId)).toEqual([]);
		} finally {
			await owner.query("delete from platform_partners where asaas_wallet_id = $1", [partnerWallet]);
			await owner.query("delete from bureau_asaas_wallets where bureau_id = $1", [B.bureau.id]);
		}
	});

	it("masks the walletId with the last 4 characters only", () => {
		expect(maskWalletId("11111111-2222-3333-4444-555555556789")).toBe("***6789");
	});

	it("never lets the runtime role change the balance columns", async () => {
		await expect(
			withUserTransaction(A.client, (c) => c.query("update affiliate_wallets set available = 999 where profile_id = $1", [A.client.userId])),
		).rejects.toThrow(/permission denied/);
	});
});
