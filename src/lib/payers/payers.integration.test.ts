// Pagador do dono (payer_profiles) contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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

import { createFakeAsaasClient, resetFakeCustomers } from "@/lib/asaas/fake";
import { readPiiKeyring } from "@/lib/config";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { PiiDecryptError } from "@/lib/pii/crypto";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedSuperadmin, seedSupportSession, seedTenant, type SeededTenant } from "@/test/seed";

import {
	claimAsaasCustomer,
	getOwnerPayerView,
	loadOwnerPayerForCharge,
	saveOwnerPayer,
	type PayerScope,
} from "./queries";
import { missingPayerFields, resolveAsaasCustomer } from "./resolve";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");
const ring1 = readPiiKeyring({ PII_ENCRYPTION_KEY: `k1:${K1}` });
const ring2 = readPiiKeyring({ PII_ENCRYPTION_KEY: `k2:${K2},k1:${K1}` });
const ringOnly2 = readPiiKeyring({ PII_ENCRYPTION_KEY: `k2:${K2}` });

// CPF válido (dígitos verificadores corretos) a partir de 9 dígitos.
function cpfFrom(base: string): string {
	const digit = (digits: string) => {
		const sum = Array.from(digits).reduce((acc, d, i) => acc + Number(d) * (digits.length + 1 - i), 0);
		const rest = (sum * 10) % 11;
		return rest === 10 ? 0 : rest;
	};
	const d1 = digit(base);
	return `${base}${d1}${digit(base + d1)}`;
}
const CPF = cpfFrom("529982247"); // 52998224725
const CPF_OTHER = cpfFrom("111444777"); // 11144477735
const CEP = "01310100";
const NUMBER = "1578";

const clientScope = (t: SeededTenant): PayerScope => ({ kind: "client", clientProfileId: t.client.userId });
const bureauScope = (t: SeededTenant): PayerScope => ({ kind: "bureau", bureauId: t.bureau.id });
const as = (identity: DbIdentity) => identity;

async function payerRows(bureauId: string) {
	const { rows } = await owner.query<{
		id: string;
		client_profile_id: string | null;
		pii_ciphertext: Buffer;
		pii_key_id: string;
		document_masked: string | null;
		postal_code_masked: string | null;
		has_address_number: boolean;
		asaas_customer_id: string | null;
		asaas_customer_owned: boolean;
		asaas_customer_stale: boolean;
		name: string | null;
		phone_e164: string | null;
	}>("select * from payer_profiles where bureau_id = $1 order by created_at", [bureauId]);
	return rows;
}

async function audits(bureauId: string, action: string) {
	const { rows } = await owner.query<{ metadata: Record<string, unknown> }>(
		"select metadata from audit_logs where bureau_id = $1 and action = $2",
		[bureauId, action],
	);
	return rows;
}

function save(t: SeededTenant, identity: DbIdentity, scope: PayerScope, patch: Record<string, string>, ring = ring1) {
	return withUserTransaction(identity, (c) => saveOwnerPayer(c, identity, scope, patch, ring));
}
function load(identity: DbIdentity, scope: PayerScope, ring = ring1) {
	return withUserTransaction(identity, (c) => loadOwnerPayerForCharge(c, identity, scope, ring));
}
function view(identity: DbIdentity, scope: PayerScope) {
	return withUserTransaction(identity, (c) => getOwnerPayerView(c, identity, scope));
}

describe("saveOwnerPayer / loadOwnerPayerForCharge", () => {
	it("stores document, postal code and number only encrypted; round trip through the API; masks for the screen", async () => {
		const t = await seedTenant(owner, "payer-rt");
		const res = await save(t, as(t.client), clientScope(t), {
			document: CPF,
			postalCode: CEP,
			addressNumber: NUMBER,
			phone: "+5511999998888",
		});
		expect(res).toEqual({ ok: true });

		const [row] = await payerRows(t.bureau.id);
		const raw = row.pii_ciphertext;
		for (const secret of [CPF, CEP, NUMBER]) {
			expect(raw.includes(Buffer.from(secret))).toBe(false);
			expect(raw.toString("hex")).not.toContain(Buffer.from(secret).toString("hex"));
		}
		expect(row.pii_key_id).toBe("k1");
		expect(row.document_masked).toBe("***.982.***-**");
		expect(row.postal_code_masked).toBe("*****-100");
		expect(row.has_address_number).toBe(true);

		const loaded = await load(as(t.client), clientScope(t));
		expect(loaded.payer).toMatchObject({ cpfCnpj: CPF, postalCode: CEP, addressNumber: NUMBER, phone: "+5511999998888" });
		expect(loaded.payerProfileId).toBe(row.id);
		expect(loaded.asaasCustomerId).toBeNull();

		const v = await view(as(t.client), clientScope(t));
		expect(v).toMatchObject({
			documentMasked: "***.982.***-**",
			postalCodeMasked: "*****-100",
			hasAddressNumber: true,
			phoneMasked: "(**) *****-8888",
			source: "payer_profile",
		});
		expect(JSON.stringify(v)).not.toContain(CPF);
		expect(JSON.stringify(v)).not.toContain(CEP);
	});

	it("audit holds field names and the mask, never full digits; an unchanged save audits nothing", async () => {
		const t = await seedTenant(owner, "payer-audit");
		await save(t, as(t.client), clientScope(t), { document: CPF, postalCode: CEP, addressNumber: NUMBER });
		await save(t, as(t.client), clientScope(t), { document: CPF, postalCode: CEP, addressNumber: NUMBER });

		const rows = await audits(t.bureau.id, "payer.update");
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject({ fields: ["document", "postalCode", "addressNumber"], payerMask: "***.982.***-**" });
		const json = JSON.stringify(rows);
		for (const secret of [CPF, CEP, NUMBER]) expect(json).not.toContain(secret);
	});

	it("rejects an invalid patch and writes nothing", async () => {
		const t = await seedTenant(owner, "payer-invalid");
		expect(await save(t, as(t.client), clientScope(t), { document: "12345678900" })).toEqual({ ok: false, reason: "invalid" });
		expect(await save(t, as(t.client), clientScope(t), { postalCode: "123" })).toEqual({ ok: false, reason: "invalid" });
		expect(await payerRows(t.bureau.id)).toHaveLength(0);
	});

	it("a blob copied to another row does not decrypt (AAD)", async () => {
		const t = await seedTenant(owner, "payer-aad");
		const sibling = await seedClientProfile(owner, t.bureau.id);
		await save(t, as(t.client), clientScope(t), { document: CPF });
		await save(t, as(sibling), { kind: "client", clientProfileId: sibling.userId }, { document: CPF_OTHER });
		const [a] = await payerRows(t.bureau.id);
		await owner.query("update payer_profiles set pii_ciphertext = $1 where client_profile_id = $2", [
			a.pii_ciphertext,
			sibling.userId,
		]);

		await expect(load(as(sibling), { kind: "client", clientProfileId: sibling.userId })).rejects.toBeInstanceOf(PiiDecryptError);
		// A linha original segue legível.
		expect((await load(as(t.client), clientScope(t))).payer.cpfCnpj).toBe(CPF);
	});

	it("unreadable blob: load throws a fixed safe error; a new save heals the row", async () => {
		const t = await seedTenant(owner, "payer-lost");
		await save(t, as(t.client), clientScope(t), { document: CPF, postalCode: CEP, addressNumber: NUMBER });

		// Chave perdida: o anel só tem uma chave que nunca cifrou esta linha.
		const lost = readPiiKeyring({ PII_ENCRYPTION_KEY: `k9:${Buffer.alloc(32, 9).toString("base64")}` });
		const error = await load(as(t.client), clientScope(t), lost).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PiiDecryptError);
		const text = `${(error as Error).message}${(error as Error).stack ?? ""}`;
		for (const secret of [CPF, CEP, NUMBER]) expect(text).not.toContain(secret);

		expect(await save(t, as(t.client), clientScope(t), { document: CPF_OTHER }, lost)).toEqual({ ok: true });
		const healed = await load(as(t.client), clientScope(t), lost);
		expect(healed.payer.cpfCnpj).toBe(CPF_OTHER);
		expect(healed.payer.postalCode).toBeUndefined();
		expect((await payerRows(t.bureau.id))[0].postal_code_masked).toBeNull();
	});

	it("a new document clears the Asaas customer; another changed field marks it stale", async () => {
		const t = await seedTenant(owner, "payer-stale");
		await save(t, as(t.client), clientScope(t), { document: CPF, postalCode: CEP, addressNumber: NUMBER });
		const [row] = await payerRows(t.bureau.id);
		await withUserTransaction(as(t.client), (c) => claimAsaasCustomer(c, row.id, "cus_1", true));

		await save(t, as(t.client), clientScope(t), { addressNumber: "99" });
		let after = (await payerRows(t.bureau.id))[0];
		expect(after).toMatchObject({ asaas_customer_id: "cus_1", asaas_customer_owned: true, asaas_customer_stale: true });

		await save(t, as(t.client), clientScope(t), { document: CPF_OTHER });
		after = (await payerRows(t.bureau.id))[0];
		expect(after).toMatchObject({ asaas_customer_id: null, asaas_customer_owned: false, asaas_customer_stale: false });
		expect(after.document_masked).toBe("***.444.***-**");
		// Os campos que não vieram no patch continuam.
		expect((await load(as(t.client), clientScope(t))).payer).toMatchObject({ postalCode: CEP, addressNumber: "99" });
	});

	it("key rotation: a row with the old key is re-encrypted with the active key on load", async () => {
		const t = await seedTenant(owner, "payer-rot");
		await save(t, as(t.client), clientScope(t), { document: CPF, postalCode: CEP });
		const before = (await payerRows(t.bureau.id))[0];

		const loaded = await load(as(t.client), clientScope(t), ring2);
		expect(loaded.payer).toMatchObject({ cpfCnpj: CPF, postalCode: CEP });
		const after = (await payerRows(t.bureau.id))[0];
		expect(after.pii_key_id).toBe("k2");
		expect(after.pii_ciphertext.equals(before.pii_ciphertext)).toBe(false);
		expect((await audits(t.bureau.id, "payer.rekey"))).toHaveLength(1);

		// Só a chave nova decifra agora; uma segunda leitura não recifra de novo.
		expect((await load(as(t.client), clientScope(t), ringOnly2)).payer.cpfCnpj).toBe(CPF);
		expect((await audits(t.bureau.id, "payer.rekey"))).toHaveLength(1);

		// Salvar depois da troca de chave também usa a ativa.
		await save(t, as(t.client), clientScope(t), { addressNumber: "7" }, ring2);
		expect((await payerRows(t.bureau.id))[0].pii_key_id).toBe("k2");
	});

	it("two concurrent claims store one id and both return the same winner", async () => {
		const t = await seedTenant(owner, "payer-race");
		await save(t, as(t.client), clientScope(t), { document: CPF });
		const [row] = await payerRows(t.bureau.id);

		const claims = await Promise.all(
			["cus_a", "cus_b"].map((id) => withUserTransaction(as(t.client), (c) => claimAsaasCustomer(c, row.id, id, true))),
		);
		expect(claims[0]).toBe(claims[1]);
		expect(["cus_a", "cus_b"]).toContain(claims[0]);
		expect((await payerRows(t.bureau.id))[0].asaas_customer_id).toBe(claims[0]);
	});

	it("two concurrent resolves for the same owner converge on one Asaas customer id", async () => {
		resetFakeCustomers();
		const t = await seedTenant(owner, "payer-race2");
		await save(t, as(t.client), clientScope(t), { document: CPF });
		const asaas = createFakeAsaasClient();

		const run = async () => {
			const current = await load(as(t.client), clientScope(t));
			return resolveAsaasCustomer(
				{
					asaas,
					claim: (id, owned) =>
						withUserTransaction(as(t.client), (c) => claimAsaasCustomer(c, current.payerProfileId!, id, owned)),
					markSynced: async () => {},
					forget: async () => {},
				},
				{
					payer: { name: "Cliente", cpfCnpj: CPF, email: "c@example.test", phone: null, postalCode: null, addressNumber: null },
					kind: "owner",
					current,
					payerProfileId: current.payerProfileId,
					chargeId: "charge-owner-race",
				},
			);
		};
		const [a, b] = await Promise.all([run(), run()]);
		expect(a).toBe(b);
		expect((await payerRows(t.bureau.id))[0].asaas_customer_id).toBe(a);
	});

	it("the other-payer flow never writes payer_profiles", async () => {
		resetFakeCustomers();
		const t = await seedTenant(owner, "payer-other");
		const asaas = createFakeAsaasClient();
		const claim = vi.fn(async (id: string) => id);
		const id = await resolveAsaasCustomer(
			{ asaas, claim, markSynced: async () => {}, forget: async () => {} },
			{
				payer: { name: "Terceiro", cpfCnpj: CPF_OTHER, email: "t@example.test", phone: null, postalCode: CEP, addressNumber: NUMBER },
				kind: "other",
				current: null,
				payerProfileId: null,
				chargeId: "charge-other-1",
			},
		);
		expect(id).toMatch(/^cus_fake_/);
		expect(claim).not.toHaveBeenCalled();
		expect(await payerRows(t.bureau.id)).toHaveLength(0);
	});
});

describe("holder fallback (D8) and missing fields", () => {
	it("a client without a row uses the own holder document, postal code and number; asks only what is missing", async () => {
		const t = await seedTenant(owner, "payer-holder");
		await owner.query("update holders set document = $2, zip_code = $3, address_number = $4 where id = $1", [
			t.holder.id,
			CPF,
			"01310-100",
			NUMBER,
		]);

		const v = await view(as(t.client), clientScope(t));
		expect(v).toMatchObject({
			source: "holder",
			documentMasked: "***.982.***-**",
			postalCodeMasked: "*****-100",
			hasAddressNumber: true,
		});
		expect(JSON.stringify(v)).not.toContain(CPF);
		// Pix com NFS-e: nada falta. Cartão: só o celular (o perfil do seed não tem).
		expect(missingPayerFields(v, "PIX", true)).toEqual([]);
		expect(missingPayerFields(v, "CREDIT_CARD", true)).toEqual(["phone"]);

		const loaded = await load(as(t.client), clientScope(t));
		expect(loaded.payer).toMatchObject({ cpfCnpj: CPF, postalCode: CEP, addressNumber: NUMBER });
		expect(loaded.payerProfileId).toBeNull();
		expect(await payerRows(t.bureau.id)).toHaveLength(0);
	});

	it("a holder with an invalid document or postal code is not treated as known data", async () => {
		const t = await seedTenant(owner, "payer-badholder");
		// O CPF do seed é aleatório e é válido em 1% das vezes: fixa um CPF inválido. O CEP tem tamanho errado.
		await owner.query(
			"update holders set document = '123.456.789-00', zip_code = '123', address_number = null where id = $1",
			[t.holder.id],
		);
		const v = await view(as(t.client), clientScope(t));
		expect(v).toMatchObject({ source: "none", documentMasked: null, postalCodeMasked: null, hasAddressNumber: false });
		expect(missingPayerFields(v, "PIX", false)).toEqual(["document"]);
	});

	it("once the row exists, the holder is no longer consulted", async () => {
		const t = await seedTenant(owner, "payer-rowwins");
		await owner.query("update holders set document = $2, zip_code = '01310100' where id = $1", [t.holder.id, CPF]);
		await save(t, as(t.client), clientScope(t), { document: CPF_OTHER });
		const v = await view(as(t.client), clientScope(t));
		expect(v).toMatchObject({ source: "payer_profile", documentMasked: "***.444.***-**", postalCodeMasked: null });
	});

	it("Bureau owner without a row: name and document are missing", async () => {
		const t = await seedTenant(owner, "payer-bureau-empty");
		const v = await view(as(t.bureauAdmin), bureauScope(t));
		expect(v.source).toBe("none");
		expect(missingPayerFields(v, "PIX", false)).toEqual(["name", "document"]);
	});
});

describe("isolation (RLS)", () => {
	it("Bureau row: bureau_admin reads and writes; operator, client and support session see nothing", async () => {
		const t = await seedTenant(owner, "payer-iso-b");
		await save(t, as(t.bureauAdmin), bureauScope(t), { name: "Empresa Ltda", document: CPF_OTHER });

		expect((await view(as(t.bureauAdmin), bureauScope(t))).documentMasked).toBe("***.444.***-**");
		expect((await load(as(t.bureauAdmin), bureauScope(t))).payer.cpfCnpj).toBe(CPF_OTHER);

		// Operador: a RLS esconde a linha, a tela vê "nenhum dado" e a carga não acha documento.
		expect((await view(as(t.operator), bureauScope(t))).source).toBe("none");
		expect((await load(as(t.operator), bureauScope(t))).payer.cpfCnpj).toBeUndefined();
		// Operador não grava nem cria uma segunda linha.
		await expect(save(t, as(t.operator), bureauScope(t), { document: CPF })).rejects.toMatchObject({ code: "42501" });

		const sa = await seedSuperadmin(owner);
		const sessionId = await seedSupportSession(owner, { superadminId: sa.userId, bureauId: t.bureau.id });
		const support: DbIdentity = { userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id, supportSessionId: sessionId };
		expect((await view(support, bureauScope(t))).source).toBe("none");
	});

	it("client row: bureau_admin, operator and another client read zero rows; the scope must be the caller's own", async () => {
		const t = await seedTenant(owner, "payer-iso-c");
		const sibling = await seedClientProfile(owner, t.bureau.id);
		await save(t, as(t.client), clientScope(t), { document: CPF, postalCode: CEP, addressNumber: NUMBER });

		for (const identity of [t.bureauAdmin, t.operator, sibling]) {
			const rows = await withUserTransaction(as(identity), (c) => c.query("select 1 from payer_profiles where client_profile_id = $1", [t.client.userId]));
			expect(rows.rowCount).toBe(0);
		}
		// Pedir a linha de outro cliente com a identidade errada falha antes de qualquer leitura.
		await expect(view(as(t.bureauAdmin), clientScope(t))).rejects.toThrow("payer scope mismatch");
		await expect(load(as(sibling), clientScope(t))).rejects.toThrow("payer scope mismatch");
		await expect(save(t, as(sibling), clientScope(t), { document: CPF })).rejects.toThrow("payer scope mismatch");
		// Bureau de outro tenant também não passa.
		const other = await seedTenant(owner, "payer-iso-other");
		await expect(view(as(other.bureauAdmin), bureauScope(t))).rejects.toThrow("payer scope mismatch");
	});
});
