// CRUD de cupons contra um Postgres real, sob RLS. Cada teste usa códigos novos.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import type { DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant, type SeededTenant } from "@/test/seed";
import { couponCreateSchema, couponUpdateSchema, type CouponCreate } from "@/lib/validators/coupons";

import { createCoupon, listCoupons, setCouponActive, updateCoupon } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let tenant: SeededTenant;
let other: SeededTenant;
let admin: DbIdentity;
let otherAdmin: DbIdentity;
let operator: DbIdentity;
let client: DbIdentity;

beforeAll(async () => {
	tenant = await seedTenant(owner, "Cupom Q");
	other = await seedTenant(owner, "Cupom Q2");
	admin = { ...tenant.bureauAdmin };
	otherAdmin = { ...other.bureauAdmin };
	operator = { ...tenant.operator };
	client = { ...tenant.client };
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const newCode = () => `T${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

function input(patch: Record<string, unknown> = {}): CouponCreate {
	return couponCreateSchema.parse({
		code: newCode(),
		kind: "percent",
		value: "10",
		allProducts: true,
		productCodes: [],
		maxUses: null,
		maxUsesPerClient: null,
		...patch,
	});
}

async function created(identity: DbIdentity, patch: Record<string, unknown> = {}) {
	const result = await createCoupon(identity, input(patch));
	if (!result.ok) throw new Error(`createCoupon failed: ${result.reason}`);
	return result.id;
}

const productRows = async (couponId: string) =>
	(await owner.query("select 1 from coupon_products where coupon_id = $1", [couponId])).rowCount;

async function auditRows(action: string, recordId: string) {
	const { rows } = await owner.query<{ user_id: string; bureau_id: string; metadata: Record<string, unknown> }>(
		"select user_id, bureau_id, metadata from audit_logs where action = $1 and record_id = $2",
		[action, recordId],
	);
	return rows;
}

describe("createCoupon", () => {
	it("grava o cupom, normaliza o código e audita na mesma transação", async () => {
		const id = await created(admin, { code: "  demo-1 ", kind: "fixed", value: "25.50", maxUses: 3 });
		const row = (await listCoupons(admin)).find((c) => c.id === id);
		expect(row).toMatchObject({
			code: "DEMO-1",
			kind: "fixed",
			value: "25.50",
			allProducts: true,
			productCodes: [],
			maxUses: 3,
			maxUsesPerClient: null,
			uses: 0,
			active: true,
		});
		const audit = await auditRows("coupon.create", id);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ user_id: admin.userId, bureau_id: tenant.bureau.id });
		expect(audit[0].metadata).toMatchObject({ code: "DEMO-1", kind: "fixed", value: "25.50" });
	});

	it("o mesmo código (com outra caixa) no mesmo Bureau é recusado; em outro Bureau passa", async () => {
		const code = newCode();
		await created(admin, { code });
		expect(await createCoupon(admin, input({ code: code.toLowerCase() }))).toEqual({ ok: false, reason: "code_taken" });
		expect((await createCoupon(otherAdmin, input({ code }))).ok).toBe(true);
	});

	it("produto específico grava os produtos; código desconhecido não grava nada", async () => {
		const id = await created(admin, { allProducts: false, productCodes: ["dossie_pf", "dossie_empresarial"] });
		expect((await listCoupons(admin)).find((c) => c.id === id)?.productCodes).toEqual([
			"dossie_empresarial",
			"dossie_pf",
		]);

		const code = newCode();
		// Código fora do catálogo: só chega aqui se a validação for burlada.
		const bad = input({ code, allProducts: false, productCodes: ["dossie_pf"] });
		bad.productCodes = ["nao_existe" as "dossie_pf"];
		expect(await createCoupon(admin, bad)).toEqual({ ok: false, reason: "product_not_found" });
		expect((await listCoupons(admin)).some((c) => c.code === code)).toBe(false);
	});

	it("operator e cliente não criam cupom (RLS)", async () => {
		await expect(createCoupon(operator, input())).rejects.toThrow();
		await expect(createCoupon(client, input())).rejects.toThrow();
	});
});

describe("updateCoupon", () => {
	it("altera campos, troca os produtos e audita", async () => {
		const id = await created(admin, { allProducts: false, productCodes: ["dossie_pf"] });
		const patch = couponUpdateSchema.parse({
			id,
			code: newCode(),
			kind: "fixed",
			value: "7.00",
			allProducts: false,
			productCodes: ["dossie_empresarial"],
			maxUses: 10,
			maxUsesPerClient: 1,
			validUntil: "2099-01-01T00:00:00.000Z",
		});
		expect(await updateCoupon(admin, patch)).toEqual({ ok: true, id });
		const row = (await listCoupons(admin)).find((c) => c.id === id);
		expect(row).toMatchObject({ kind: "fixed", value: "7.00", productCodes: ["dossie_empresarial"], maxUses: 10, maxUsesPerClient: 1 });
		expect(row?.validUntil?.toISOString()).toBe("2099-01-01T00:00:00.000Z");
		const audit = await auditRows("coupon.update", id);
		expect(audit).toHaveLength(1);
		const { before, after } = audit[0].metadata as { before: Record<string, unknown>; after: Record<string, unknown> };
		expect(before).toMatchObject({ kind: "percent", value: "10.00", products: ["dossie_pf"], max_uses: null, valid_until: null });
		expect(after).toMatchObject({ kind: "fixed", value: "7.00", products: ["dossie_empresarial"], max_uses: 10, max_uses_per_client: 1 });
		expect(after.valid_until).toBe("2099-01-01T00:00:00+00:00");
		expect(before.valid_from).toEqual(expect.any(String));
		expect(JSON.stringify(audit[0].metadata)).not.toMatch(/cpf|cnpj/i);
	});

	it("com todos os produtos as linhas de coupon_products somem", async () => {
		const id = await created(admin, { allProducts: false, productCodes: ["dossie_pf"] });
		expect(await productRows(id)).toBe(1);
		const patch = couponUpdateSchema.parse({
			id,
			code: newCode(),
			kind: "percent",
			value: "10",
			allProducts: true,
			productCodes: ["dossie_pf"],
			maxUses: null,
			maxUsesPerClient: null,
		});
		expect(await updateCoupon(admin, patch)).toEqual({ ok: true, id });
		expect(await productRows(id)).toBe(0);
	});

	it("validade que o banco recusa vira invalid_period e não grava nada", async () => {
		const id = await created(admin, { validFrom: "2099-06-01T00:00:00.000Z" });
		const patch = couponUpdateSchema.parse({
			id,
			code: newCode(),
			kind: "percent",
			value: "10",
			allProducts: true,
			maxUses: null,
			maxUsesPerClient: null,
			validUntil: "2099-01-01T00:00:00.000Z",
		});
		expect(await updateCoupon(admin, patch)).toEqual({ ok: false, reason: "invalid_period" });
		expect(await auditRows("coupon.update", id)).toHaveLength(0);
	});

	it("outro Bureau não vê nem altera o cupom", async () => {
		const id = await created(admin, { code: "SECRETO1" });
		expect((await listCoupons(otherAdmin)).some((c) => c.id === id)).toBe(false);

		const patch = couponUpdateSchema.parse({
			id,
			code: "HACKEADO",
			kind: "percent",
			value: "100",
			allProducts: true,
			maxUses: null,
			maxUsesPerClient: null,
		});
		expect(await updateCoupon(otherAdmin, patch)).toEqual({ ok: false, reason: "not_found" });
		expect(await setCouponActive(otherAdmin, { id, active: false })).toEqual({ ok: false, reason: "not_found" });

		const row = (await listCoupons(admin)).find((c) => c.id === id);
		expect(row).toMatchObject({ code: "SECRETO1", value: "10.00", active: true });
		expect(await auditRows("coupon.update", id)).toHaveLength(0);
		expect(await auditRows("coupon.deactivate", id)).toHaveLength(0);
	});
});

describe("setCouponActive", () => {
	it("desativa e reativa, auditando cada passo", async () => {
		const id = await created(admin);
		expect(await setCouponActive(admin, { id, active: false })).toEqual({ ok: true });
		expect((await listCoupons(admin)).find((c) => c.id === id)?.active).toBe(false);
		expect(await auditRows("coupon.deactivate", id)).toHaveLength(1);

		expect(await setCouponActive(admin, { id, active: true })).toEqual({ ok: true });
		expect((await listCoupons(admin)).find((c) => c.id === id)?.active).toBe(true);
		expect(await auditRows("coupon.activate", id)).toHaveLength(1);
		expect(await auditRows("coupon.update", id)).toHaveLength(0);
	});
});

describe("listCoupons", () => {
	it("só lista cupons do próprio Bureau", async () => {
		const id = await created(admin);
		const otherId = await created(otherAdmin);
		const mine = (await listCoupons(admin)).map((c) => c.id);
		expect(mine).toContain(id);
		expect(mine).not.toContain(otherId);
	});

	it("operator e cliente não leem cupons (RLS)", async () => {
		await created(admin);
		expect(await listCoupons(operator)).toEqual([]);
		expect(await listCoupons(client)).toEqual([]);
	});
});
