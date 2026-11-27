// Núcleo de afiliados (migração 026) contra um Postgres real: pool do dono para preparar e conferir,
// pool app_runtime para chamar as funções públicas e ler sob RLS.
import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import { randomCpf, seedClientProfile, seedTenant, withDbContext, type SeededTenant } from "@/test/seed";

import { getMyAffiliateSummary } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const newPhone = () => `+55639${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
// Um IP por cadastro: o limite do cadastro é por IP e a tabela persiste entre execuções.
const newIp = () => `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
const newKey = () => `k-${randomBytes(6).toString("hex")}`;

type Account = { userId: string; email: string; phone: string; digits: string; code: string };
type RegisterOverrides = { email?: string; phone?: string; digits?: string; referralCode?: string | null };

let A: SeededTenant;
let B: SeededTenant;

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	[A, B] = await Promise.all([seedTenant(owner, "Aff A"), seedTenant(owner, "Aff B")]);
});

afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending') and bureau_id = any($1::uuid[])`,
		[[A.bureau.id, B.bureau.id]],
	);
	await Promise.all([owner.end(), app.end()]);
	await releaseClaimLock();
});

async function register(tenant: SeededTenant, overrides: RegisterOverrides = {}) {
	const digits = overrides.digits ?? onlyDigits(randomCpf());
	const email = overrides.email ?? `${randomUUID()}@example.test`;
	const phone = overrides.phone ?? newPhone();
	const { rows } = await app.query<{ ok: boolean; reason: string | null; user_id: string | null }>(
		`select ok, reason, user_id from register_client($1, 'PF', 'Maria Teste', $2, $3, $4, $5, 2, 1, $6::inet,
		   'vitest-agent/1.0', $7, 'https://app.example.test', $8)`,
		[
			tenant.bureau.slug, digits, email, phone, `hash-${randomBytes(16).toString("hex")}`, newIp(),
			randomBytes(32).toString("base64url"), overrides.referralCode ?? null,
		],
	);
	return { result: rows[0], digits, email, phone };
}

async function registerAccount(tenant: SeededTenant): Promise<Account> {
	const { result, digits, email, phone } = await register(tenant);
	expect(result).toMatchObject({ ok: true, reason: null });
	const userId = result.user_id as string;
	const { rows } = await owner.query<{ code: string }>("select code from affiliate_codes where profile_id = $1", [userId]);
	return { userId, email, phone, digits, code: rows[0].code };
}

const referralOf = async (referredId: string) =>
	(await owner.query<{ affiliate_profile_id: string; bureau_id: string }>(
		"select affiliate_profile_id, bureau_id from affiliate_referrals where referred_profile_id = $1",
		[referredId],
	)).rows;

describe("código e carteira de comissão", () => {
	it("gives a new client an 8-character code and an empty commission wallet", async () => {
		const client = await seedClientProfile(owner, A.bureau.id);
		const { rows: codes } = await owner.query<{ code: string; bureau_id: string }>(
			"select code, bureau_id from affiliate_codes where profile_id = $1",
			[client.userId],
		);
		expect(codes).toHaveLength(1);
		expect(codes[0].code).toMatch(/^[a-z0-9]{8}$/);
		expect(codes[0].bureau_id).toBe(A.bureau.id);
		const { rows: wallets } = await owner.query(
			"select pending, available from affiliate_wallets where profile_id = $1",
			[client.userId],
		);
		expect(wallets).toEqual([{ pending: "0.00", available: "0.00" }]);
	});

	it("does not give codes or wallets to staff", async () => {
		const { rows } = await owner.query(
			"select 1 from affiliate_codes where profile_id = any($1::uuid[])",
			[[A.bureauAdmin.userId, A.operator.userId]],
		);
		expect(rows).toHaveLength(0);
	});

	it("backfills an existing client (the function the migration backfill uses), once", async () => {
		const client = await seedClientProfile(owner, A.bureau.id);
		await owner.query("delete from affiliate_wallets where profile_id = $1", [client.userId]);
		await owner.query("delete from affiliate_codes where profile_id = $1", [client.userId]);
		await owner.query("select affiliate_provision($1, $2)", [client.userId, A.bureau.id]);
		await owner.query("select affiliate_provision($1, $2)", [client.userId, A.bureau.id]);
		const { rows: codes } = await owner.query("select code from affiliate_codes where profile_id = $1", [client.userId]);
		const { rows: wallets } = await owner.query("select 1 from affiliate_wallets where profile_id = $1", [client.userId]);
		expect(codes).toHaveLength(1);
		expect(wallets).toHaveLength(1);
	});

	it("seeds the settings keys", async () => {
		const { rows } = await owner.query<{ key: string; value: unknown }>(
			"select key, value from settings where key like 'affiliate\\_%' order by key",
		);
		expect(rows).toEqual([
			{ key: "affiliate_cash_in_hold_days", value: 0 },
			{ key: "affiliate_commission_hold_days", value: 30 },
			{ key: "affiliate_withdrawal_fee", value: { fixed: 0, percent: 0 } },
		]);
	});
});

describe("register_client com código de indicação", () => {
	let affiliate: Account;

	beforeAll(async () => {
		affiliate = await registerAccount(A);
	});

	it("links a new account to the affiliate of the same bureau", async () => {
		const { result } = await register(A, { referralCode: affiliate.code });
		expect(result).toMatchObject({ ok: true, reason: null });
		expect(await referralOf(result.user_id as string)).toEqual([
			{ affiliate_profile_id: affiliate.userId, bureau_id: A.bureau.id },
		]);
		const { rows } = await owner.query<{ metadata: Record<string, unknown> }>(
			"select metadata from audit_logs where action = 'affiliate.referral_linked' and record_id = $1",
			[result.user_id],
		);
		expect(rows).toEqual([{ metadata: { affiliate_profile_id: affiliate.userId } }]);
	});

	it("registers without a link for a code of another bureau, an unknown code or a malformed code", async () => {
		const foreign = await registerAccount(B);
		for (const referralCode of [foreign.code, "zzzzzzzz", "NOT-A-CODE"]) {
			const { result } = await register(A, { referralCode });
			expect(result).toMatchObject({ ok: true, reason: null });
			expect(await referralOf(result.user_id as string)).toEqual([]);
		}
	});

	it("registers without a link when the code owner is anonymized", async () => {
		const gone = await registerAccount(A);
		await owner.query("update profiles set anonymized_at = now() where id = $1", [gone.userId]);
		const { result } = await register(A, { referralCode: gone.code });
		expect(result).toMatchObject({ ok: true, reason: null });
		expect(await referralOf(result.user_id as string)).toEqual([]);
	});

	it("never links a self-referral by phone", async () => {
		const { result } = await register(A, { referralCode: affiliate.code, phone: affiliate.phone });
		expect(result).toMatchObject({ ok: true, reason: null });
		expect(await referralOf(result.user_id as string)).toEqual([]);
	});

	// Mesmo e-mail e mesmo documento já são recusados pelo cadastro (email_in_use, document_in_use): nenhum vínculo nasce.
	it("never links a self-referral by e-mail or by document", async () => {
		const sameEmail = await register(A, { referralCode: affiliate.code, email: affiliate.email });
		expect(sameEmail.result).toMatchObject({ ok: false, reason: "email_in_use", user_id: null });
		const sameDocument = await register(A, { referralCode: affiliate.code, digits: affiliate.digits });
		expect(sameDocument.result).toMatchObject({ ok: false, reason: "document_in_use", user_id: null });
		const { rows } = await owner.query("select 1 from affiliate_referrals where affiliate_profile_id = $1", [affiliate.userId]);
		expect(rows).toHaveLength(1); // só o vínculo do primeiro caso
	});

	it("keeps the 13-argument call working (code is optional)", async () => {
		const { rows } = await app.query<{ ok: boolean }>(
			`select ok from register_client($1, 'PF', 'Maria Teste', $2, $3, $4, $5, 2, 1, $6::inet, 'vitest-agent/1.0', $7,
			   'https://app.example.test')`,
			[
				A.bureau.slug, onlyDigits(randomCpf()), `${randomUUID()}@example.test`, newPhone(),
				`hash-${randomBytes(16).toString("hex")}`, newIp(), randomBytes(32).toString("base64url"),
			],
		);
		expect(rows[0].ok).toBe(true);
	});
});

describe("affiliate_wallet_post_entry", () => {
	type Post = { ok: boolean; reason: string | null; entry_id: string | null; pending: string | null; available: string | null; replayed: boolean };
	let affiliateId: string;

	const post = async (kind: string, amount: string, key = newKey()) =>
		(await owner.query<Post>("select * from affiliate_wallet_post_entry($1, $2, $3, $4, 'test', $1)", [affiliateId, kind, amount, key])).rows[0];

	beforeAll(async () => {
		affiliateId = (await seedClientProfile(owner, A.bureau.id)).userId;
	});

	it("moves money pending -> available and refuses to overdraw", async () => {
		expect(await post("commission", "40.00")).toMatchObject({ ok: true, pending: "40.00", available: "0.00", replayed: false });
		expect(await post("commission_release", "40.00")).toMatchObject({ ok: true, pending: "0.00", available: "40.00" });
		expect(await post("conversion", "50.00")).toMatchObject({ ok: false, reason: "insufficient_funds", entry_id: null });
		expect(await post("commission_reversal", "1.00")).toMatchObject({ ok: false, reason: "insufficient_funds" });
		expect(await post("withdrawal_hold", "15.00")).toMatchObject({ ok: true, available: "25.00" });
		expect(await post("withdrawal_paid", "15.00")).toMatchObject({ ok: true, pending: "0.00", available: "25.00" });
		expect(await post("withdrawal_hold", "10.00")).toMatchObject({ ok: true, available: "15.00" });
		expect(await post("withdrawal_release", "10.00")).toMatchObject({ ok: true, available: "25.00" });
		expect(await post("conversion", "25.00")).toMatchObject({ ok: true, pending: "0.00", available: "0.00" });
		const { rows } = await owner.query("select pending, available from affiliate_wallets where profile_id = $1", [affiliateId]);
		expect(rows).toEqual([{ pending: "0.00", available: "0.00" }]);
	});

	it("reverses a pending commission", async () => {
		expect(await post("commission", "12.34")).toMatchObject({ ok: true, pending: "12.34" });
		expect(await post("commission_reversal", "12.34")).toMatchObject({ ok: true, pending: "0.00" });
	});

	it("replays the same key and rejects a changed request on that key", async () => {
		const key = newKey();
		const first = await post("commission", "7.00", key);
		const again = await post("commission", "7.00", key);
		expect(again).toMatchObject({ ok: true, replayed: true, entry_id: first.entry_id, pending: first.pending });
		expect(await post("commission", "8.00", key)).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		const { rows } = await owner.query("select 1 from affiliate_ledger_entries where profile_id = $1 and idempotency_key = $2", [affiliateId, key]);
		expect(rows).toHaveLength(1);
	});

	it("validates kind, key, amount and wallet", async () => {
		expect(await post("topup", "1.00")).toMatchObject({ ok: false, reason: "not_allowed" });
		expect(await post("commission", "1.00", " ")).toMatchObject({ ok: false, reason: "invalid_key" });
		expect(await post("commission", "0.00")).toMatchObject({ ok: false, reason: "invalid_amount" });
		expect(await post("commission", "1.005")).toMatchObject({ ok: false, reason: "invalid_amount" });
		const { rows } = await owner.query<Post>(
			"select * from affiliate_wallet_post_entry($1, 'commission', 1, $2, null, $1)",
			[A.bureauAdmin.userId, newKey()],
		);
		expect(rows[0]).toMatchObject({ ok: false, reason: "not_found" });
	});

	it("serializes concurrent debits: the balance never goes negative", async () => {
		await post("commission", "50.00");
		await post("commission_release", "50.00");
		const results = await Promise.all([post("conversion", "40.00"), post("withdrawal_hold", "40.00")]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ reason: "insufficient_funds" })]);
	});

	it("is not executable by app_runtime", async () => {
		await expect(
			app.query("select * from affiliate_wallet_post_entry($1, 'commission', 1, $2, null, $1)", [affiliateId, newKey()]),
		).rejects.toMatchObject({ code: "42501" });
	});
});

describe("client_wallet_post_entry commission_credit", () => {
	it("adds the converted commission to the available credits, once per key", async () => {
		const client = await seedClientProfile(owner, A.bureau.id);
		const key = newKey();
		const call = async () =>
			(await owner.query<{ ok: boolean; available: string; replayed: boolean }>(
				"select ok, available, replayed from client_wallet_post_entry($1, 'commission_credit', 40.00, $2, 'conversion', null, $1)",
				[client.userId, key],
			)).rows[0];
		expect(await call()).toEqual({ ok: true, available: "40.00", replayed: false });
		expect(await call()).toEqual({ ok: true, available: "40.00", replayed: true });
		const { rows } = await owner.query("select kind, amount from client_ledger_entries where client_profile_id = $1", [client.userId]);
		expect(rows).toEqual([{ kind: "commission_credit", amount: "40.00" }]);
	});
});

describe("getMyAffiliateSummary", () => {
	it("returns only the caller's own code, wallet, referrals and commissions", async () => {
		const affiliate = await registerAccount(A);
		const { result } = await register(A, { referralCode: affiliate.code });
		const referredId = result.user_id as string;
		const stranger = await seedClientProfile(owner, A.bureau.id);
		await owner.query(
			`insert into affiliate_commissions (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount, release_at)
			 values ($1, $2, $3, $4, 10, 100.00, 10.00, now() + interval '30 days')`,
			[randomUUID(), A.bureau.id, affiliate.userId, referredId],
		);
		await owner.query("select affiliate_wallet_post_entry($1, 'commission', 10, $2, 'test', $1)", [affiliate.userId, newKey()]);

		const summary = await withDbContext(app, { userId: affiliate.userId, role: "client", bureauId: A.bureau.id }, getMyAffiliateSummary);
		expect(summary).toMatchObject({
			code: affiliate.code,
			wallet: { pending: "10.00", available: "0.00" },
			referrals: [{ name: "Maria Teste", totalSpent: "0" }],
			commissions: [{ referredName: "Maria Teste", amount: "10.00", status: "pending", orderValue: "0.00", productName: "" }],
		});
		expect(JSON.stringify(summary)).not.toContain(affiliate.digits);

		const none = await withDbContext(app, { userId: stranger.userId, role: "client", bureauId: A.bureau.id }, async (client) => {
			const own = await getMyAffiliateSummary(client);
			return own && { referrals: own.referrals, commissions: own.commissions };
		});
		expect(none).toEqual({ referrals: [], commissions: [] });
	});

	it("returns null outside a client session", async () => {
		const summary = await withDbContext(app, { userId: A.operator.userId, role: "operator", bureauId: A.bureau.id }, getMyAffiliateSummary);
		expect(summary).toBeNull();
	});
});
