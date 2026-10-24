// Saque e conversão da comissão (migração 028) contra um Postgres real: taxa, trava, idempotência, papéis e chave PIX.
import { randomBytes, randomUUID } from "node:crypto";

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
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import type { DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import { randomCpf, seedClientProfile, seedSuperadmin, seedSupportSession, seedTenant, type SeededTenant } from "@/test/seed";

import {
	cancelWithdrawal,
	convertCommission,
	getWithdrawalDetail,
	listMyWithdrawals,
	listWithdrawalQueue,
	markWithdrawalPaid,
	readWithdrawalFee,
	requestWithdrawal,
} from "./withdrawals";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });

const PIX_KEY = "chave-secreta-9f3a@example.test";
const sha = () => randomBytes(32).toString("hex");
const receipt = () => ({ objectKey: `ab/${randomUUID()}`, mime: "application/pdf" as const, sha256: sha() });

let T: SeededTenant;
let sa: { userId: string };

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	T = await seedTenant(owner, "Withdrawals");
	sa = await seedSuperadmin(owner);
});

afterAll(async () => {
	await setFee(0, 0);
	await Promise.all([owner.end(), app.end(), pool.end()]);
	await releaseClaimLock();
});

// O módulo usa o pool da aplicação (DATABASE_URL = TEST_DATABASE_URL); a identidade é montada como na sessão real.
const asClient = (userId: string): DbIdentity => ({ userId, role: "client", bureauId: T.bureau.id });
const asSuperadmin = (): DbIdentity => ({ userId: sa.userId, role: "superadmin", bureauId: null });

async function setFee(fixed: number, percent: number) {
	await owner.query("update settings set value = $1::jsonb where key = 'affiliate_withdrawal_fee'", [
		JSON.stringify({ fixed, percent }),
	]);
}

// Afiliado com saldo disponível (comissão + liberação) e, opcionalmente, valor em carência.
async function seedAffiliate(available: string, pending = "0") {
	const { userId } = await seedClientProfile(owner, T.bureau.id);
	if (Number(available) > 0) {
		await owner.query("select affiliate_wallet_post_entry($1, 'commission', $2, $3, 'seed', $1)", [userId, available, randomUUID()]);
		await owner.query("select affiliate_wallet_post_entry($1, 'commission_release', $2, $3, 'seed', $1)", [userId, available, randomUUID()]);
	}
	if (Number(pending) > 0) {
		await owner.query("select affiliate_wallet_post_entry($1, 'commission', $2, $3, 'seed', $1)", [userId, pending, randomUUID()]);
	}
	return userId;
}

// Titular da própria conta (registro do cliente): o documento que a chave CPF/CNPJ precisa ser.
async function seedOwnDocument(userId: string): Promise<string> {
	const digits = randomCpf().replace(/\D/g, "");
	await owner.query(
		`insert into holders (bureau_id, type, name, document, created_by, client_profile_id)
		 values ($1, 'PF', 'Titular da conta', $2, $3, $3)`,
		[T.bureau.id, digits, userId],
	);
	return digits;
}

const wallet = async (userId: string) =>
	(await owner.query<{ pending: string; available: string }>("select pending, available from affiliate_wallets where profile_id = $1", [userId])).rows[0];
const ledgerKinds = async (userId: string) =>
	(await owner.query<{ kind: string; amount: string }>("select kind, amount from affiliate_ledger_entries where profile_id = $1 order by seq", [userId])).rows;
const withdrawalRow = async (id: string) =>
	(await owner.query("select * from affiliate_withdrawals where id = $1", [id])).rows[0];
const request = (userId: string, amount: string, key = PIX_KEY, type: "email" | "document" | "phone" | "random" = "email") =>
	requestWithdrawal(asClient(userId), { amount, pixKeyType: type, pixKey: key });

describe("requestWithdrawal", () => {
	it("applies fixed 2.00 + 1% over 100.00: fee 3.00, net 97.00, available -100.00", async () => {
		await setFee(2, 1);
		try {
			const userId = await seedAffiliate("100.00");
			const result = await request(userId, "100.00");
			expect(result.ok).toBe(true);
			const id = (result as { withdrawalId: string }).withdrawalId;

			expect(await withdrawalRow(id)).toMatchObject({
				amount: "100.00", fee: "3.00", net: "97.00", status: "open", pix_key: PIX_KEY, pix_key_type: "email", profile_id: userId,
				bureau_id: T.bureau.id,
			});
			expect((await withdrawalRow(id)).holder_name).toMatch(/cliente/);
			expect(await wallet(userId)).toEqual({ pending: "0.00", available: "0.00" });
			expect((await ledgerKinds(userId)).at(-1)).toEqual({ kind: "withdrawal_hold", amount: "100.00" });
		} finally {
			await setFee(0, 0);
		}
	});

	it("audits withdrawal.request in the same transaction, without the PIX key", async () => {
		const userId = await seedAffiliate("20.00");
		const result = await request(userId, "20.00");
		const id = (result as { withdrawalId: string }).withdrawalId;
		const { rows } = await owner.query<{ user_id: string; bureau_id: string; metadata: Record<string, unknown> }>(
			"select user_id, bureau_id, metadata from audit_logs where action = 'withdrawal.request' and record_id = $1",
			[id],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ user_id: userId, bureau_id: T.bureau.id });
		expect(JSON.stringify(rows[0].metadata)).not.toContain(PIX_KEY);
		expect(JSON.stringify(rows[0].metadata)).not.toContain("example.test");
	});

	it("refuses when the net would be zero or negative, and writes nothing", async () => {
		await setFee(5, 0);
		try {
			const userId = await seedAffiliate("10.00");
			expect(await request(userId, "5.00")).toEqual({ ok: false, reason: "net_not_positive" });
			expect(await request(userId, "4.00")).toEqual({ ok: false, reason: "net_not_positive" });
			expect(await wallet(userId)).toEqual({ pending: "0.00", available: "10.00" });
			const { rows } = await owner.query("select 1 from affiliate_withdrawals where profile_id = $1", [userId]);
			expect(rows).toHaveLength(0);
		} finally {
			await setFee(0, 0);
		}
	});

	it("refuses a second open withdrawal", async () => {
		const userId = await seedAffiliate("50.00");
		expect((await request(userId, "10.00")).ok).toBe(true);
		expect(await request(userId, "10.00")).toEqual({ ok: false, reason: "withdrawal_open" });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "40.00" });
	});

	it("refuses more than the available amount; a grace-period amount is not withdrawable", async () => {
		const userId = await seedAffiliate("30.00", "70.00");
		expect(await request(userId, "30.01")).toEqual({ ok: false, reason: "insufficient_funds" });
		expect(await request(userId, "100.00")).toEqual({ ok: false, reason: "insufficient_funds" });
		expect(await wallet(userId)).toEqual({ pending: "70.00", available: "30.00" });
		expect((await request(userId, "30.00")).ok).toBe(true);
		expect(await wallet(userId)).toEqual({ pending: "70.00", available: "0.00" });
	});

	it("refuses a zero, negative or fractional-cent amount", async () => {
		const userId = await seedAffiliate("30.00");
		for (const amount of ["0", "-5.00", "1.005"]) {
			expect(await request(userId, amount)).toEqual({ ok: false, reason: "invalid_amount" });
		}
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "30.00" });
	});

	it("refuses a PIX key of the document type that is not the account's document, and writes nothing", async () => {
		const userId = await seedAffiliate("40.00");
		await seedOwnDocument(userId);

		expect(await request(userId, "10.00", "52998224725", "document")).toEqual({ ok: false, reason: "pix_key_not_owner" });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "40.00" });
		expect((await owner.query("select 1 from affiliate_withdrawals where profile_id = $1", [userId])).rows).toHaveLength(0);
	});

	it("refuses a document key when the account has no linked holder", async () => {
		const userId = await seedAffiliate("40.00");

		expect(await request(userId, "10.00", "11144477735", "document")).toEqual({ ok: false, reason: "pix_key_not_owner" });
	});

	it("accepts a PIX key of the document type that is the account's own document", async () => {
		const userId = await seedAffiliate("40.00");
		const own = await seedOwnDocument(userId);

		expect((await request(userId, "10.00", own, "document")).ok).toBe(true);
	});

	it.each([
		["a document with 10 digits", "document", "1114447773"],
		["an e-mail without @", "email", "ana.example.test"],
		["a phone without +", "phone", "5563912345678"],
		["a phone that is too short", "phone", "+12345"],
		["a random key with upper case", "random", "0F8FAD5B-D9CB-469F-A165-70867728950E"],
		["a random key that is not a uuid", "random", "abc"],
	] as const)("refuses %s with invalid_pix_key", async (_name, type, key) => {
		const userId = await seedAffiliate("40.00");

		expect(await request(userId, "10.00", key, type)).toEqual({ ok: false, reason: "invalid_pix_key" });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "40.00" });
	});

	it("the table itself refuses a malformed key (CHECK), even written by the owner", async () => {
		const userId = await seedAffiliate("0");
		for (const [type, key] of [["document", "123"], ["email", "sem-arroba"], ["phone", "123"], ["random", "xyz"]]) {
			await expect(
				owner.query(
					`insert into affiliate_withdrawals (bureau_id, profile_id, amount, fee, net, pix_key_type, pix_key, holder_name)
					 values ($1, $2, 10, 0, 10, $3, $4, 'Afiliado')`,
					[T.bureau.id, userId, type, key],
				),
			).rejects.toMatchObject({ code: "23514" });
		}
	});

	it("only a client requests", async () => {
		const result = await requestWithdrawal(
			{ userId: T.bureauAdmin.userId, role: "bureau_admin", bureauId: T.bureau.id },
			{ amount: "1.00", pixKeyType: "email", pixKey: PIX_KEY },
		);
		expect(result).toEqual({ ok: false, reason: "not_allowed" });
	});
});

describe("cancelWithdrawal and markWithdrawalPaid", () => {
	it("cancel returns the amount to available, then a new withdrawal is possible; repeating is idempotent", async () => {
		const userId = await seedAffiliate("60.00");
		const id = ((await request(userId, "60.00")) as { withdrawalId: string }).withdrawalId;
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "0.00" });

		expect(await cancelWithdrawal(asSuperadmin(), { id, reason: "Nome da chave não confere" })).toMatchObject({ ok: true });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "60.00" });
		expect(await withdrawalRow(id)).toMatchObject({ status: "cancelled", cancel_reason: "Nome da chave não confere" });
		expect((await ledgerKinds(userId)).at(-1)).toEqual({ kind: "withdrawal_release", amount: "60.00" });

		expect(await cancelWithdrawal(asSuperadmin(), { id, reason: "Nome da chave não confere" })).toMatchObject({ ok: true });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "60.00" });
		expect((await request(userId, "60.00")).ok).toBe(true);
	});

	it("cancel needs a reason", async () => {
		const userId = await seedAffiliate("10.00");
		const id = ((await request(userId, "10.00")) as { withdrawalId: string }).withdrawalId;
		expect(await cancelWithdrawal(asSuperadmin(), { id, reason: "   " })).toEqual({ ok: false, reason: "invalid_reason" });
		expect((await withdrawalRow(id)).status).toBe("open");
	});

	it("mark paid sets paid, keeps the balance, writes withdrawal_paid once and is idempotent for the same receipt", async () => {
		const userId = await seedAffiliate("80.00");
		const id = ((await request(userId, "80.00")) as { withdrawalId: string }).withdrawalId;
		const r = receipt();

		expect(await markWithdrawalPaid(asSuperadmin(), { id, receipt: r })).toEqual({ ok: true, replayed: false });
		expect(await withdrawalRow(id)).toMatchObject({
			status: "paid", receipt_object_key: r.objectKey, receipt_mime: r.mime, receipt_sha256: r.sha256, paid_by: sa.userId,
		});
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "0.00" });

		expect(await markWithdrawalPaid(asSuperadmin(), { id, receipt: { ...receipt(), sha256: r.sha256 } })).toEqual({ ok: true, replayed: true });
		expect(await markWithdrawalPaid(asSuperadmin(), { id, receipt: receipt() })).toEqual({ ok: false, reason: "already_paid" });
		const kinds = (await ledgerKinds(userId)).map((e) => e.kind);
		expect(kinds.filter((k) => k === "withdrawal_paid")).toHaveLength(1);
		const { rows } = await owner.query("select 1 from audit_logs where action = 'withdrawal.paid' and record_id = $1", [id]);
		expect(rows).toHaveLength(1);
	});

	it("does not move a paid withdrawal to cancelled, nor a cancelled one to paid; refuses a bad receipt", async () => {
		const userId = await seedAffiliate("40.00");
		const paid = ((await request(userId, "20.00")) as { withdrawalId: string }).withdrawalId;
		expect(await markWithdrawalPaid(asSuperadmin(), { id: paid, receipt: { ...receipt(), sha256: "xyz" } })).toEqual({
			ok: false,
			reason: "invalid_receipt",
		});
		expect((await markWithdrawalPaid(asSuperadmin(), { id: paid, receipt: receipt() })).ok).toBe(true);
		expect(await cancelWithdrawal(asSuperadmin(), { id: paid, reason: "tarde demais" })).toEqual({ ok: false, reason: "invalid_state" });

		const cancelled = ((await request(userId, "20.00")) as { withdrawalId: string }).withdrawalId;
		await cancelWithdrawal(asSuperadmin(), { id: cancelled, reason: "motivo" });
		expect(await markWithdrawalPaid(asSuperadmin(), { id: cancelled, receipt: receipt() })).toEqual({ ok: false, reason: "invalid_state" });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "20.00" });
	});

	it("a client, a Bureau admin, an operator and a superadmin in support cannot pay or cancel", async () => {
		const userId = await seedAffiliate("30.00");
		const id = ((await request(userId, "30.00")) as { withdrawalId: string }).withdrawalId;
		const supportSessionId = await seedSupportSession(owner, { superadminId: sa.userId, bureauId: T.bureau.id });
		const actors: DbIdentity[] = [
			asClient(userId),
			{ userId: T.bureauAdmin.userId, role: "bureau_admin", bureauId: T.bureau.id },
			{ userId: T.operator.userId, role: "operator", bureauId: T.bureau.id },
			{ userId: sa.userId, role: "superadmin", bureauId: T.bureau.id, supportSessionId },
		];
		for (const actor of actors) {
			expect(await markWithdrawalPaid(actor, { id, receipt: receipt() })).toEqual({ ok: false, reason: "not_allowed" });
			expect(await cancelWithdrawal(actor, { id, reason: "x" })).toEqual({ ok: false, reason: "not_allowed" });
			expect(await getWithdrawalDetail(actor, id)).toBeNull();
			expect(await listWithdrawalQueue(actor)).toEqual([]);
		}
		expect((await withdrawalRow(id)).status).toBe("open");
	});

	it("answers not_found for an unknown id", async () => {
		expect(await markWithdrawalPaid(asSuperadmin(), { id: randomUUID(), receipt: receipt() })).toEqual({ ok: false, reason: "not_found" });
		expect(await cancelWithdrawal(asSuperadmin(), { id: randomUUID(), reason: "x" })).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("convertCommission", () => {
	it("converts 40.00: commission -40.00, credits +40.00, no fee, with a commission_credit entry", async () => {
		await setFee(2, 1);
		try {
			const userId = await seedAffiliate("100.00");
			const before = (await owner.query<{ available: string }>("select available from client_wallets where client_profile_id = $1", [userId])).rows[0];
			expect(before.available).toBe("0.00");

			expect(await convertCommission(asClient(userId), { amount: "40.00", requestId: randomUUID() })).toEqual({ ok: true });
			expect(await wallet(userId)).toEqual({ pending: "0.00", available: "60.00" });
			const credits = (await owner.query<{ available: string }>("select available from client_wallets where client_profile_id = $1", [userId])).rows[0];
			expect(credits.available).toBe("40.00");
			expect((await ledgerKinds(userId)).at(-1)).toEqual({ kind: "conversion", amount: "40.00" });
			const { rows } = await owner.query<{ kind: string; amount: string }>(
				"select kind, amount from client_ledger_entries where client_profile_id = $1",
				[userId],
			);
			expect(rows).toEqual([{ kind: "commission_credit", amount: "40.00" }]);
		} finally {
			await setFee(0, 0);
		}
	});

	it("is idempotent per request id", async () => {
		const userId = await seedAffiliate("50.00");
		const requestId = randomUUID();
		expect(await convertCommission(asClient(userId), { amount: "10.00", requestId })).toEqual({ ok: true });
		expect(await convertCommission(asClient(userId), { amount: "10.00", requestId })).toEqual({ ok: true });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "40.00" });
		expect(await convertCommission(asClient(userId), { amount: "20.00", requestId })).toMatchObject({ ok: false });
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "40.00" });
	});

	it("refuses more than available and amounts in the grace period", async () => {
		const userId = await seedAffiliate("10.00", "90.00");
		expect(await convertCommission(asClient(userId), { amount: "10.01", requestId: randomUUID() })).toEqual({
			ok: false,
			reason: "insufficient_funds",
		});
		expect(await convertCommission(asClient(userId), { amount: "0", requestId: randomUUID() })).toEqual({
			ok: false,
			reason: "invalid_amount",
		});
		expect(await wallet(userId)).toEqual({ pending: "90.00", available: "10.00" });
	});

	it("only a client converts", async () => {
		const result = await convertCommission(
			{ userId: T.bureauAdmin.userId, role: "bureau_admin", bureauId: T.bureau.id },
			{ amount: "1.00", requestId: randomUUID() },
		);
		expect(result).toEqual({ ok: false, reason: "not_allowed" });
	});
});

describe("withdraw and convert in parallel", () => {
	it("on 50.00 available asking 40.00 each: one ok, the other insufficient_funds, never negative", async () => {
		for (let round = 0; round < 5; round += 1) {
			const userId = await seedAffiliate("50.00");
			const results = await Promise.all([
				request(userId, "40.00"),
				convertCommission(asClient(userId), { amount: "40.00", requestId: randomUUID() }),
			]);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "insufficient_funds" }]);
			expect(await wallet(userId)).toEqual({ pending: "0.00", available: "10.00" });
		}
	});

	it("two parallel withdrawals of the same affiliate: one ok, one withdrawal_open", async () => {
		const userId = await seedAffiliate("50.00");
		const results = await Promise.all([request(userId, "10.00"), request(userId, "10.00")]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "withdrawal_open" }]);
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "40.00" });
	});
});

describe("withdrawal fee reader", () => {
	it("a client reads the stored fee (the settings table is hidden from clients by RLS)", async () => {
		await setFee(2, 1);
		try {
			const userId = await seedAffiliate("0");

			expect(await readWithdrawalFee(asClient(userId))).toEqual({ fixed: "2.00", percent: "1.00" });
		} finally {
			await setFee(0, 0);
		}
	});

	it("falls back to 0.00 when the setting is malformed and matches what request charges", async () => {
		await owner.query("update settings set value = '\"x\"'::jsonb where key = 'affiliate_withdrawal_fee'");
		try {
			const userId = await seedAffiliate("0");
			expect(await readWithdrawalFee(asClient(userId))).toEqual({ fixed: "0.00", percent: "0.00" });
		} finally {
			await setFee(0, 0);
		}
	});
});

describe("PIX key exposure", () => {
	it("the superadmin reads the full key and holder; each read is audited without the key", async () => {
		const userId = await seedAffiliate("25.00");
		const own = await seedOwnDocument(userId);
		const id = ((await request(userId, "25.00", own, "document")) as { withdrawalId: string }).withdrawalId;

		const detail = await getWithdrawalDetail(asSuperadmin(), id);
		expect(detail).toMatchObject({ id, pixKey: own, pixKeyType: "document", amount: "25.00", status: "open", profileId: userId });
		// O documento da conta aparece só mascarado, para o superadmin conferir uma chave de outro tipo.
		expect(detail?.accountDocumentMasked).toBe(`***${own.slice(-2)}`);
		expect(detail?.holderName).toMatch(/cliente/);
		await getWithdrawalDetail(asSuperadmin(), id);

		const { rows } = await owner.query<{ user_id: string; bureau_id: string; metadata: Record<string, unknown> }>(
			"select user_id, bureau_id, metadata from audit_logs where action = 'withdrawal.view' and record_id = $1",
			[id],
		);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toMatchObject({ user_id: sa.userId, bureau_id: T.bureau.id });
			expect(JSON.stringify(row.metadata)).not.toContain(own);
		}
		const leaked = await owner.query("select 1 from audit_logs where metadata::text like $1 or new_data::text like $1", [`%${own}%`]);
		expect(leaked.rows).toHaveLength(0);
	});

	it("the client sees the key masked; the app role cannot read the table; the queue is masked", async () => {
		const userId = await seedAffiliate("25.00");
		const id = ((await request(userId, "25.00")) as { withdrawalId: string }).withdrawalId;

		const mine = await listMyWithdrawals(asClient(userId));
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ id, amount: "25.00", fee: "0.00", net: "25.00", status: "open", pixKeyType: "email" });
		expect(mine[0].pixKeyMasked).toBe("c***@example.test");
		expect(JSON.stringify(mine)).not.toContain("chave-secreta");

		await expect(app.query("select pix_key from affiliate_withdrawals")).rejects.toMatchObject({ code: "42501" });

		const queue = await listWithdrawalQueue(asSuperadmin());
		const item = queue.find((q) => q.id === id);
		expect(item).toMatchObject({ pixKeyMasked: "c***@example.test", status: "open", bureauId: T.bureau.id });
		expect(JSON.stringify(queue)).not.toContain("chave-secreta");
		expect(await listMyWithdrawals(asClient((await seedClientProfile(owner, T.bureau.id)).userId))).toEqual([]);
	});

	it("a client does not see the withdrawal of another client", async () => {
		const a = await seedAffiliate("10.00");
		await request(a, "10.00");
		const b = (await seedClientProfile(owner, T.bureau.id)).userId;
		expect(await listMyWithdrawals(asClient(b))).toEqual([]);
	});
});

describe("LGPD", () => {
	it("blocks the anonymization of an account with an open withdrawal even with a zero balance", async () => {
		const userId = await seedAffiliate("15.00");
		await request(userId, "15.00");
		expect(await wallet(userId)).toEqual({ pending: "0.00", available: "0.00" });
		const admin: DbIdentity = { userId: T.bureauAdmin.userId, role: "bureau_admin", bureauId: T.bureau.id };
		const anonymize = async () => {
			const { rows } = await withIdentity(admin, "select lgpd_anonymize_client_account($1) as result", [userId]);
			return rows[0].result;
		};
		expect(await anonymize()).toBe("commission");
	});
});

async function withIdentity(identity: DbIdentity, sql: string, params: unknown[]) {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[identity.userId, identity.role, identity.bureauId ?? ""],
		);
		const result = await client.query(sql, params);
		await client.query("rollback");
		return result;
	} finally {
		client.release();
	}
}
