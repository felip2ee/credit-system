// M6 / migration 022: pedido, autorização e entrega contra um Postgres real. Pool do dono para preparar e conferir,
// pool app_runtime para chamar as funções sob RLS.
import { randomInt, randomUUID } from "node:crypto";

import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientProfile,
	seedClientWalletTopup,
	seedDossier,
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const cpf = () => onlyDigits(randomCpf());
const cnpj = () => Array.from({ length: 14 }, () => randomInt(0, 10)).join("");
const maskCpf = (d: string) => `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
// E-mail novo a cada chamada: o teto de pedidos por destinatário conta o Bureau inteiro, e o Bureau T é compartilhado.
const mail = () => `contato-${randomUUID()}@example.test`;
const QUOTE = (code: string) => JSON.stringify({ lines: [{ code }] });

type Identity = { userId: string; role: string; bureauId: string };

let T: SeededTenant;
let U: SeededTenant;
const bureauIds: string[] = [];

// Preço de venda por código; custo fixo de 1,00. O Dossiê Empresarial cobra 10,00 (custo 1,00) por sócio.
async function sell(t: SeededTenant, prices: Partial<Record<string, string>>, cost = "1.00") {
	for (const code of ["dossie_pf", "dossie_empresarial"]) {
		const price = prices[code];
		if (!price) continue;
		const perPartner = code === "dossie_empresarial";
		// O seed do catálogo deixa os produtos inativos.
		await owner.query("update products set active = true where code = $1", [code]);
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, {
			bureauId: t.bureau.id,
			productId: rows[0].id,
			cost,
			costPerPartner: perPartner ? cost : "0.00",
			setBy: t.bureauAdmin.userId,
		});
		await seedCatalogItem(owner, {
			bureauId: t.bureau.id,
			productId: rows[0].id,
			salePrice: price,
			salePricePerPartner: perPartner ? "10.00" : "0.00",
			updatedBy: t.bureauAdmin.userId,
		});
	}
}

const ALL_PRICES = { dossie_pf: "50.00", dossie_empresarial: "80.00" };

async function newTenant(
	label: string,
	prices: Partial<Record<string, string>> = ALL_PRICES,
	cost = "1.00",
): Promise<SeededTenant> {
	const t = await seedTenant(owner, label);
	bureauIds.push(t.bureau.id);
	await sell(t, prices, cost);
	return t;
}

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	[T, U] = await Promise.all([newTenant("ord T"), newTenant("ord U")]);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
	await releaseClaimLock();
});

// Confirma a transação (withDbContext faz rollback): as funções gravam e o dono confere depois.
async function committed<T>(
	identity: { userId: string; role: string; bureauId: string | null },
	work: (client: PoolClient) => Promise<T>,
	supportSessionId = "",
): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true), set_config('app.support_session_id', $4, true)`,
			[identity.userId, identity.role, identity.bureauId ?? "", supportSessionId],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type OpenArgs = {
	product: string;
	self: boolean;
	type: string | null;
	name: string | null;
	document: string | null;
	partners: unknown[] | null;
	email: string | null;
	phone: string | null;
	buyer: string | null;
};
type OpenResult = { ok: boolean; reason: string | null; dossier_id: string | null; state: string | null };

function openOrder(client: Client | PoolClient, args: Partial<OpenArgs> = {}): Promise<OpenResult> {
	const a: OpenArgs = {
		product: "dossie_pf",
		self: false,
		type: "PF",
		name: "Fulano de Tal",
		document: cpf(),
		partners: null,
		email: null,
		phone: null,
		buyer: null,
		...args,
	};
	return client
		.query<OpenResult>("select * from open_order($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)", [
			a.product,
			a.self,
			a.type,
			a.name,
			a.document,
			a.partners === null ? null : JSON.stringify(a.partners),
			a.email,
			a.phone,
			a.buyer,
		])
		.then((r) => r.rows[0]);
}

const staff = (t: SeededTenant): Identity => t.operator;

type Buyer = { identity: Identity; email: string; holderId: string; digits: string };

// Cliente novo do Bureau com o Titular próprio (PF ou PJ) e e-mail de conta. Só a conta PJ pesquisa outra pessoa.
async function newBuyer(t: SeededTenant, type: "PF" | "PJ" = "PF"): Promise<Buyer> {
	const identity = await seedClientProfile(owner, t.bureau.id);
	const digits = type === "PF" ? cpf() : cnpj();
	const { rows } = await owner.query<{ email: string }>("select email from profiles where id = $1", [identity.userId]);
	const holder = await owner.query<{ id: string }>(
		`insert into holders (bureau_id, type, name, document, email, client_profile_id, created_by)
     values ($1, $5, 'Comprador Teste', $2, $3, $4, $4) returning id`,
		[t.bureau.id, digits, rows[0].email, identity.userId, type],
	);
	return { identity, email: rows[0].email, holderId: holder.rows[0].id, digits };
}

// Os triggers de perfil bloqueiam o dono do pool: o teste os desliga só nesta transação.
async function asReplica(sql: string, params: unknown[]) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query(sql, params);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

const setProfilePhone = (profileId: string, phone: string, verified: boolean) =>
	asReplica("update profiles set phone_e164 = $2, phone_verified_at = case when $3::boolean then now() end where id = $1", [
		profileId,
		phone,
		verified,
	]);

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}

const depsProduct = async (code: string) =>
	(
		await rows<{ deps_product: string }>(
			`select v.deps_product from product_versions v join products p on p.id = v.product_id
        where p.code = $1 order by v.version desc limit 1`,
			[code],
		)
	)[0].deps_product;

const authorize = (holderId: string, interval = "30 days") =>
	owner.query(
		`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + $2::interval
      where holder_id = $1 and status = 'pending'`,
		[holderId, interval],
	);

describe("open_order", () => {
	it("client opens an own order in one transaction", async () => {
		const b = await newBuyer(T);
		const result = await committed(b.identity, (c) => openOrder(c, { self: true, type: null, name: null, document: null }));
		expect(result).toMatchObject({ ok: true, reason: null, state: "awaiting_authorization" });
		const dossierId = result.dossier_id as string;

		const [dossier] = await rows("select kind, status, product, holder_id from dossiers where id = $1", [dossierId]);
		expect(dossier).toEqual({
			kind: "PF",
			status: "pending",
			product: await depsProduct("dossie_pf"),
			holder_id: b.holderId,
		});
		const consultations = await rows(
			"select status, scr_mode, product, requires_auth, scr_email, scr_authorization_id from consultations where dossier_id = $1",
			[dossierId],
		);
		expect(consultations).toHaveLength(1);
		expect(consultations[0]).toMatchObject({
			status: "pending_authorization",
			scr_mode: "internal",
			product: await depsProduct("dossie_pf"),
			requires_auth: true,
			scr_email: b.email,
		});
		const [order] = await rows(
			`select mode, client_profile_id, product_code, ai_status, self_research, subject_document_masked, state, created_by
         from dossier_orders where dossier_id = $1`,
			[dossierId],
		);
		expect(order).toEqual({
			mode: "online",
			client_profile_id: b.identity.userId,
			product_code: "dossie_pf",
			ai_status: "pending",
			self_research: true,
			subject_document_masked: maskCpf(b.digits),
			state: "awaiting_authorization",
			created_by: b.identity.userId,
		});
		const scr = await rows(
			"select id, status, email, client_profile_id, channel, phone_e164, document, requested_by from scr_authorizations where holder_id = $1",
			[b.holderId],
		);
		expect(scr).toHaveLength(1);
		expect(scr[0]).toMatchObject({
			status: "pending",
			email: b.email,
			client_profile_id: b.identity.userId,
			channel: "internal",
			phone_e164: null,
			document: b.digits,
			requested_by: b.identity.userId,
		});
		expect(consultations[0].scr_authorization_id).toBe(scr[0].id);

		const audit = await rows<{ metadata: unknown; user_id: string }>(
			"select metadata, user_id from audit_logs where action = 'order.open' and record_id = $1",
			[dossierId],
		);
		expect(audit).toHaveLength(1);
		expect(audit[0].user_id).toBe(b.identity.userId);
		expect(audit[0].metadata).toEqual({ mode: "online", product_code: "dossie_pf", members: 1, self_member: true });
		expect(JSON.stringify(audit[0].metadata)).not.toContain(b.digits);
		const timeline = await rows<{ metadata: { dossier_id: string; mode: string; product_code: string } }>(
			"select metadata from timeline_events where entity_id = $1 and event_type = 'order.opened'",
			[b.holderId],
		);
		expect(timeline).toHaveLength(1);
		expect(timeline[0].metadata).toEqual({ dossier_id: dossierId, mode: "online", product_code: "dossie_pf" });
	});

	it("an own document typed as another person still counts as own research", async () => {
		const b = await newBuyer(T);
		const result = await committed(b.identity, (c) =>
			openOrder(c, { document: b.digits, name: "Outro Nome", email: mail() }),
		);
		expect(result.ok).toBe(true);
		const [order] = await rows("select self_research from dossier_orders where dossier_id = $1", [result.dossier_id]);
		expect(order.self_research).toBe(true);
		const [scr] = await rows("select email from scr_authorizations where holder_id = $1", [b.holderId]);
		expect(scr.email).toBe(b.email);
	});

	it("own research sends the phone only when it is verified", async () => {
		const verified = await newBuyer(T);
		await setProfilePhone(verified.identity.userId, "+5563999990001", true);
		const unverified = await newBuyer(T);
		await setProfilePhone(unverified.identity.userId, "+5563999990002", false);
		for (const [b, phone] of [[verified, "+5563999990001"], [unverified, null]] as const) {
			await committed(b.identity, (c) => openOrder(c, { self: true }));
			const [scr] = await rows("select phone_e164 from scr_authorizations where holder_id = $1", [b.holderId]);
			expect(scr.phone_e164).toBe(phone);
		}
	});

	it("self order without an own holder is refused", async () => {
		const lone = await seedClientProfile(owner, T.bureau.id);
		const result = await committed(lone, (c) => openOrder(c, { self: true }));
		expect(result).toMatchObject({ ok: false, reason: "self_holder_missing", dossier_id: null });
	});

	it("third party order never updates an existing holder", async () => {
		const b = await newBuyer(T, "PJ");
		const document = cpf();
		await owner.query(
			`insert into holders (bureau_id, type, name, document, email, created_by)
       values ($1, 'PF', 'Nome Antigo', $2, 'antigo@example.test', $3)`,
			[T.bureau.id, document, T.bureauAdmin.userId],
		);
		const contact = mail();
		const result = await committed(b.identity, (c) =>
			openOrder(c, { name: "Nome Novo", document, email: contact, phone: "+5563999990003" }),
		);
		expect(result.ok).toBe(true);
		const holders = await rows("select name, email, created_by from holders where bureau_id = $1 and document_digits = $2", [
			T.bureau.id,
			document,
		]);
		expect(holders).toEqual([{ name: "Nome Antigo", email: "antigo@example.test", created_by: T.bureauAdmin.userId }]);
		const [scr] = await rows("select email, phone_e164, client_profile_id from scr_authorizations where holder_id = (select id from holders where bureau_id = $1 and document_digits = $2)", [
			T.bureau.id,
			document,
		]);
		expect(scr).toEqual({ email: contact, phone_e164: "+5563999990003", client_profile_id: b.identity.userId });
		const [order] = await rows("select subject_name, subject_document_masked, self_research from dossier_orders where dossier_id = $1", [
			result.dossier_id,
		]);
		expect(order).toEqual({ subject_name: "Nome Novo", subject_document_masked: maskCpf(document), self_research: false });
	});

	it("third party order creates the holder without contact data", async () => {
		const b = await newBuyer(T, "PJ");
		const document = cpf();
		await committed(b.identity, (c) => openOrder(c, { name: "Pessoa Nova", document, email: mail() }));
		const [holder] = await rows("select name, email, phone, client_profile_id, created_by, type from holders where bureau_id = $1 and document_digits = $2", [
			T.bureau.id,
			document,
		]);
		expect(holder).toEqual({
			name: "Pessoa Nova",
			email: null,
			phone: null,
			client_profile_id: null,
			created_by: b.identity.userId,
			type: "PF",
		});
	});

	it("contact equal to the buyer is refused", async () => {
		const b = await newBuyer(T, "PJ");
		await setProfilePhone(b.identity.userId, "+5563999990004", true);
		const document = cpf();
		const sameEmail = await committed(b.identity, (c) =>
			openOrder(c, { document, email: b.email.toUpperCase() }),
		);
		expect(sameEmail).toMatchObject({ ok: false, reason: "contact_is_buyer" });
		const samePhone = await committed(b.identity, (c) =>
			openOrder(c, { document, email: mail(), phone: "+5563999990004" }),
		);
		expect(samePhone).toMatchObject({ ok: false, reason: "contact_is_buyer" });
		// Recusa não deixa Titular nem Dossiê para trás.
		expect(await rows("select 1 from holders where bureau_id = $1 and document_digits = $2", [T.bureau.id, document])).toHaveLength(0);
		expect(await rows("select 1 from dossiers where created_by = $1", [b.identity.userId])).toHaveLength(0);
	});

	it("counter order with a buyer refuses the buyer's own contact", async () => {
		const b = await newBuyer(T);
		await setProfilePhone(b.identity.userId, "+5563999990005", true);
		const document = cpf();
		const sameEmail = await committed(staff(T), (c) =>
			openOrder(c, { document, email: b.email.toUpperCase(), buyer: b.identity.userId }),
		);
		expect(sameEmail).toMatchObject({ ok: false, reason: "contact_is_buyer" });
		const samePhone = await committed(staff(T), (c) =>
			openOrder(c, { document, email: mail(), phone: "+5563999990005", buyer: b.identity.userId }),
		);
		expect(samePhone).toMatchObject({ ok: false, reason: "contact_is_buyer" });
		const partnerIsBuyer = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: mail(),
				partners: [{ document: cpf(), name: "Sócio", email: b.email }],
				buyer: b.identity.userId,
			}),
		);
		expect(partnerIsBuyer).toMatchObject({ ok: false, reason: "contact_is_buyer" });
		expect(await rows("select 1 from holders where bureau_id = $1 and document_digits = $2", [T.bureau.id, document])).toHaveLength(0);
		// Sem comprador (balcão avulso) o contato é livre.
		const noBuyer = await committed(staff(T), (c) => openOrder(c, { document, email: b.email }));
		expect(noBuyer.ok).toBe(true);
	});

	it("a fourth third party request to the same e-mail or phone within 24 h is too_many_requests", async () => {
		const b = await newBuyer(T, "PJ");
		const email = mail();
		for (let i = 0; i < 3; i += 1) {
			expect((await committed(b.identity, (c) => openOrder(c, { email }))).ok).toBe(true);
		}
		const holdersBefore = await rows("select 1 from holders where bureau_id = $1", [T.bureau.id]);

		const fourth = await committed(b.identity, (c) => openOrder(c, { email }));

		expect(fourth).toMatchObject({ ok: false, reason: "too_many_requests", dossier_id: null });
		expect(await rows("select 1 from holders where bureau_id = $1", [T.bureau.id])).toHaveLength(holdersBefore.length);
		// O teto vale também para o mesmo celular com outro e-mail, e o balcão está sujeito a ele.
		const phone = "+5563999990006";
		for (let i = 0; i < 3; i += 1) {
			expect((await committed(staff(T), (c) => openOrder(c, { email: mail(), phone }))).ok).toBe(true);
		}
		expect(await committed(staff(T), (c) => openOrder(c, { email: mail(), phone }))).toMatchObject({ ok: false, reason: "too_many_requests" });
		// Pedido de 25 h atrás não conta.
		await owner.query("update scr_authorizations set requested_at = now() - interval '25 hours' where lower(email) = $1", [email]);
		expect((await committed(b.identity, (c) => openOrder(c, { email }))).ok).toBe(true);
	});

	it("third party order needs a valid contact e-mail", async () => {
		const b = await newBuyer(T, "PJ");
		for (const email of [null, "sem-arroba", ""]) {
			const result = await committed(b.identity, (c) => openOrder(c, { email }));
			expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		const badPhone = await committed(b.identity, (c) => openOrder(c, { email: mail(), phone: "63999990000" }));
		expect(badPhone).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("same buyer reuses a valid authorization", async () => {
		const b = await newBuyer(T);
		await committed(b.identity, (c) => openOrder(c, { self: true }));
		await authorize(b.holderId);
		const second = await committed(b.identity, (c) => openOrder(c, { self: true }));
		expect(second).toMatchObject({ ok: true, state: "ready" });
		const scr = await rows("select id from scr_authorizations where holder_id = $1", [b.holderId]);
		expect(scr).toHaveLength(1);
		const linked = await rows("select scr_authorization_id from consultations where dossier_id = $1", [second.dossier_id]);
		expect(linked).toEqual([{ scr_authorization_id: scr[0].id }]);
	});

	it("another buyer gets a new request", async () => {
		const first = await newBuyer(T, "PJ");
		const second = await newBuyer(T, "PJ");
		const document = cpf();
		const args = { document, email: mail() };
		await committed(first.identity, (c) => openOrder(c, args));
		const [holder] = await rows<{ id: string }>("select id from holders where bureau_id = $1 and document_digits = $2", [T.bureau.id, document]);
		await authorize(holder.id);
		const other = await committed(second.identity, (c) => openOrder(c, args));
		expect(other).toMatchObject({ ok: true, state: "awaiting_authorization" });
		const scr = await rows("select client_profile_id, status from scr_authorizations where holder_id = $1 order by requested_at, id", [holder.id]);
		expect(scr).toHaveLength(2);
		expect(new Set(scr.map((r) => r.client_profile_id))).toEqual(new Set([first.identity.userId, second.identity.userId]));
	});

	it("expired authorization gets a new request", async () => {
		const b = await newBuyer(T);
		await committed(b.identity, (c) => openOrder(c, { self: true }));
		await authorize(b.holderId, "-1 minute");
		const again = await committed(b.identity, (c) => openOrder(c, { self: true }));
		expect(again).toMatchObject({ ok: true, state: "awaiting_authorization" });
		expect(await rows("select 1 from scr_authorizations where holder_id = $1", [b.holderId])).toHaveLength(2);
	});

	it("pending request in scope is linked, not duplicated", async () => {
		const b = await newBuyer(T, "PJ");
		const document = cpf();
		const args = { document, email: mail() };
		const first = await committed(b.identity, (c) => openOrder(c, args));
		const second = await committed(b.identity, (c) => openOrder(c, args));
		const scr = await rows<{ id: string }>(
			"select id from scr_authorizations where holder_id = (select id from holders where bureau_id = $1 and document_digits = $2)",
			[T.bureau.id, document],
		);
		expect(scr).toHaveLength(1);
		const linked = await rows(
			"select distinct scr_authorization_id from consultations where dossier_id = any($1::uuid[])",
			[[first.dossier_id, second.dossier_id]],
		);
		expect(linked).toEqual([{ scr_authorization_id: scr[0].id }]);
	});

	it("pending request past its deadline is not reused", async () => {
		const b = await newBuyer(T);
		await committed(b.identity, (c) => openOrder(c, { self: true }));
		await owner.query("update scr_authorizations set request_expires_at = now() - interval '1 minute' where holder_id = $1", [b.holderId]);
		await committed(b.identity, (c) => openOrder(c, { self: true }));
		expect(await rows("select 1 from scr_authorizations where holder_id = $1", [b.holderId])).toHaveLength(2);
	});

	it("client cannot order an unknown product, pass partners on dossie_pf or pass a buyer", async () => {
		const b = await newBuyer(T, "PJ");
		const unknown = await committed(b.identity, (c) => openOrder(c, { product: "consulta_pf", email: mail() }));
		expect(unknown).toMatchObject({ ok: false, reason: "invalid_input" });
		const partners = await committed(b.identity, (c) =>
			openOrder(c, { email: mail(), partners: [{ document: cpf(), name: "Sócio", email: mail() }] }),
		);
		expect(partners).toMatchObject({ ok: false, reason: "invalid_input" });
		const buyer = await committed(b.identity, (c) => openOrder(c, { email: mail(), buyer: T.client.userId }));
		expect(buyer).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("product not for sale", async () => {
		const bare = await newTenant("ord bare", {});
		const bareBuyer = await newBuyer(bare);
		const result = await committed(bareBuyer.identity, (c) => openOrder(c, { self: true }));
		expect(result).toMatchObject({ ok: false, reason: "product_not_for_sale" });
		// Preço abaixo do custo efetivo também tira o produto da venda.
		const cheap = await seedTenant(owner, "ord cheap");
		bureauIds.push(cheap.bureau.id);
		await sell(cheap, { dossie_pf: "5.00" }, "1.00");
		await owner.query(
			"insert into bureau_product_costs (bureau_id, product_id, cost, set_by) select $1, id, 9.00, $2 from products where code = 'dossie_pf'",
			[cheap.bureau.id, cheap.bureauAdmin.userId],
		);
		const cheapBuyer = await newBuyer(cheap);
		const underCost = await committed(cheapBuyer.identity, (c) => openOrder(c, { self: true }));
		expect(underCost).toMatchObject({ ok: false, reason: "product_not_for_sale" });
		// Preço por sócio abaixo do custo por sócio idem.
		const partnerCheap = await seedTenant(owner, "ord partner cheap");
		bureauIds.push(partnerCheap.bureau.id);
		await sell(partnerCheap, { dossie_empresarial: "50.00" }, "1.00");
		await owner.query(
			"insert into bureau_product_costs (bureau_id, product_id, cost, cost_per_partner, set_by) select $1, id, 1.00, 11.00, $2 from products where code = 'dossie_empresarial'",
			[partnerCheap.bureau.id, partnerCheap.bureauAdmin.userId],
		);
		const partnerBuyer = await newBuyer(partnerCheap);
		const underPartnerCost = await committed(partnerBuyer.identity, (c) =>
			openOrder(c, { product: "dossie_empresarial", type: "PJ", document: cnpj(), email: mail() }),
		);
		expect(underPartnerCost).toMatchObject({ ok: false, reason: "product_not_for_sale" });
	});

	it("every order starts with the opinion pending", async () => {
		const b = await newBuyer(T);
		const own = await committed(b.identity, (c) => openOrder(c, { self: true }));
		const counter = await committed(staff(T), (c) => openOrder(c, { email: mail() }));
		for (const placed of [own, counter]) {
			const [order] = await rows("select ai_status from dossier_orders where dossier_id = $1", [placed.dossier_id]);
			expect(order).toEqual({ ai_status: "pending" });
		}
	});

	it("kind mismatch", async () => {
		const pj = await newBuyer(T, "PJ");
		const pjOnPf = await committed(pj.identity, (c) => openOrder(c, { type: "PJ", document: cnpj(), email: mail() }));
		expect(pjOnPf).toMatchObject({ ok: false, reason: "kind_mismatch" });
		const pfOnPj = await committed(pj.identity, (c) =>
			openOrder(c, { product: "dossie_empresarial", type: "PF", document: cpf(), email: mail() }),
		);
		expect(pfOnPj).toMatchObject({ ok: false, reason: "kind_mismatch" });
		const wrongLength = await committed(pj.identity, (c) => openOrder(c, { document: cnpj(), email: mail() }));
		expect(wrongLength).toMatchObject({ ok: false, reason: "kind_mismatch" });
		const b = await newBuyer(T);
		const selfOnPj = await committed(b.identity, (c) => openOrder(c, { product: "dossie_empresarial", self: true, type: "PJ" }));
		expect(selfOnPj).toMatchObject({ ok: false, reason: "kind_mismatch" });
	});

	it("dossie_empresarial without partners opens a PJ_FULL dossier for any CNPJ", async () => {
		const b = await newBuyer(T);
		const document = cnpj();
		const result = await committed(b.identity, (c) =>
			openOrder(c, { product: "dossie_empresarial", type: "PJ", document, name: "Empresa Teste", email: mail() }),
		);
		expect(result.ok).toBe(true);
		const [dossier] = await rows("select kind, product from dossiers where id = $1", [result.dossier_id]);
		expect(dossier).toEqual({ kind: "PJ_FULL", product: await depsProduct("dossie_empresarial") });
		const [holder] = await rows("select type from holders where bureau_id = $1 and document_digits = $2", [T.bureau.id, document]);
		expect(holder.type).toBe("PJ");
		// Sem e-mail do responsável o online é recusado.
		const noContact = await committed(b.identity, (c) =>
			openOrder(c, { product: "dossie_empresarial", type: "PJ", document: cnpj(), email: null }),
		);
		expect(noContact).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("online dossie_pf: a PF account only orders its own document, a PJ account orders its manager's CPF", async () => {
		const pf = await newBuyer(T);
		const other = await committed(pf.identity, (c) => openOrder(c, { document: cpf(), email: mail() }));
		expect(other).toMatchObject({ ok: false, reason: "third_party_not_allowed", dossier_id: null });
		const own = await committed(pf.identity, (c) => openOrder(c, { document: pf.digits, email: mail() }));
		expect(own.ok).toBe(true);
		const pj = await newBuyer(T, "PJ");
		const manager = await committed(pj.identity, (c) => openOrder(c, { document: cpf(), name: "Responsável", email: mail() }));
		expect(manager).toMatchObject({ ok: true, state: "awaiting_authorization" });
		const noEmail = await committed(pj.identity, (c) => openOrder(c, { document: cpf(), email: null }));
		expect(noEmail).toMatchObject({ ok: false, reason: "invalid_input" });
		// Conta PJ não compra o Dossiê Pessoa Física dela mesma: o Titular dela é PJ.
		const selfOnPf = await committed(pj.identity, (c) => openOrder(c, { self: true }));
		expect(selfOnPf).toMatchObject({ ok: false, reason: "kind_mismatch" });
	});

	it("D12: online, a partner may share the buyer e-mail only with the account holder's CPF", async () => {
		const b = await newBuyer(T, "PJ");
		const company = cnpj();
		const partners = (document: string) => [{ document, name: "Sócio", email: b.email }];
		const otherCpf = await committed(b.identity, (c) =>
			openOrder(c, { product: "dossie_empresarial", type: "PJ", document: company, email: mail(), partners: partners(cpf()) }),
		);
		expect(otherCpf).toMatchObject({ ok: false, reason: "contact_is_buyer", dossier_id: null });
		// O titular da conta tem o CPF de uma pessoa: o comprador é sócio da empresa que ele consulta.
		const holderCpf = cpf();
		await owner.query(
			`insert into holders (bureau_id, type, name, document, client_profile_id, created_by)
       values ($1, 'PF', 'Titular PF da conta', $2, $3, $3)`,
			[T.bureau.id, holderCpf, b.identity.userId],
		);
		const sameCpf = await committed(b.identity, (c) =>
			openOrder(c, { product: "dossie_empresarial", type: "PJ", document: company, email: mail(), partners: partners(holderCpf) }),
		);
		expect(sameCpf.ok).toBe(true);
		const [audit] = await rows("select metadata from audit_logs where action = 'order.open' and record_id = $1", [sameCpf.dossier_id]);
		expect(audit.metadata).toMatchObject({ members: 2, self_member: true });
		// Balcão: o e-mail do comprador nunca vale, nem com o CPF dele.
		const counter = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: mail(),
				partners: partners(holderCpf),
				buyer: b.identity.userId,
			}),
		);
		expect(counter).toMatchObject({ ok: false, reason: "contact_is_buyer" });
	});

	it("D12 exception: online, the company contact may be the buyer e-mail only when the account CPF is a partner", async () => {
		const b = await newBuyer(T); // Titular PF da conta: b.digits
		const company = cnpj();
		const open = (partners: { document: string; name: string; email: string }[]) =>
			committed(b.identity, (c) =>
				openOrder(c, { product: "dossie_empresarial", type: "PJ", document: company, name: "Empresa", email: b.email, partners }),
			);
		const withoutX = await open([{ document: cpf(), name: "Sócio Z", email: mail() }]);
		expect(withoutX).toMatchObject({ ok: false, reason: "contact_is_buyer", dossier_id: null });
		const withX = await open([
			{ document: b.digits, name: "Comprador Sócio", email: b.email },
			{ document: cpf(), name: "Sócio Z", email: mail() },
		]);
		expect(withX.ok).toBe(true);
		const [audit] = await rows("select metadata from audit_logs where action = 'order.open' and record_id = $1", [withX.dossier_id]);
		expect(audit.metadata).toMatchObject({ members: 3, self_member: true, buyer_as_company_contact: true });
		expect(JSON.stringify(audit.metadata)).not.toContain(b.digits);
		// Outro sócio com o e-mail do comprador continua exigindo o CPF da conta.
		const otherPartner = await open([
			{ document: b.digits, name: "Comprador Sócio", email: mail() },
			{ document: cpf(), name: "Sócio Z", email: b.email },
		]);
		expect(otherPartner).toMatchObject({ ok: false, reason: "contact_is_buyer" });
		// Sem o e-mail do comprador, a exceção não aparece na trilha.
		const plain = await committed(b.identity, (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: mail(),
				partners: [{ document: b.digits, name: "Comprador Sócio", email: b.email }],
			}),
		);
		expect(plain.ok).toBe(true);
		const [plainAudit] = await rows("select metadata from audit_logs where action = 'order.open' and record_id = $1", [plain.dossier_id]);
		expect(plainAudit.metadata).not.toHaveProperty("buyer_as_company_contact");
		// Balcão: o contato da empresa nunca é o comprador, nem com o CPF dele entre os sócios.
		const counter = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: b.email,
				partners: [{ document: b.digits, name: "Comprador Sócio", email: mail() }],
				buyer: b.identity.userId,
			}),
		);
		expect(counter).toMatchObject({ ok: false, reason: "contact_is_buyer" });
	});

	it("online dossie_empresarial accepts partners; they are CPF-only", async () => {
		const b = await newBuyer(T);
		const result = await committed(b.identity, (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: mail(),
				partners: [
					{ document: cpf(), name: "Sócio Um", email: mail() },
					{ document: cpf(), name: "Sócio Dois", email: mail() },
				],
			}),
		);
		expect(result).toMatchObject({ ok: true, state: "awaiting_authorization" });
		expect(await rows("select 1 from consultations where dossier_id = $1", [result.dossier_id])).toHaveLength(3);
	});

	it("online writes no partnership at all; the counter writes it as operator data", async () => {
		const sourcesOf = (dossierId: string | null) =>
			rows<{ source: string }>(
				"select p.source from holder_partnerships p join dossiers d on d.holder_id = p.company_id where d.id = $1",
				[dossierId],
			);
		const b = await newBuyer(T);
		const online = await committed(b.identity, (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: mail(),
				partners: [{ document: cpf(), name: "Sócio Online", email: mail() }],
			}),
		);
		expect(online.ok).toBe(true);
		expect(await sourcesOf(online.dossier_id)).toEqual([]);
		const counter = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				name: "Empresa Balcão",
				document: cnpj(),
				email: mail(),
				partners: [{ document: cpf(), name: "Sócio Balcão", email: mail() }],
			}),
		);
		expect(counter.ok).toBe(true);
		expect(await sourcesOf(counter.dossier_id)).toEqual([{ source: "operator" }]);
	});

	it("superadmin in support, no context and a bad role are not_allowed", async () => {
		const sa = await seedSuperadmin(owner);
		const session = await seedSupportSession(owner, { superadminId: sa.userId, bureauId: T.bureau.id });
		const inSupport = await committed(
			{ userId: sa.userId, role: "superadmin", bureauId: T.bureau.id },
			(c) => openOrder(c, { email: mail() }),
			session,
		);
		expect(inSupport).toMatchObject({ ok: false, reason: "not_allowed" });
		const bare = await app.query<OpenResult>(
			"select * from open_order('dossie_pf', false, 'PF', 'Fulano', $1, null, 'x@example.test', null, null)",
			[cpf()],
		);
		expect(bare.rows[0]).toMatchObject({ ok: false, reason: "not_allowed" });
	});

	it("staff opens a counter order in awaiting_payment", async () => {
		const contact = mail();
		const result = await committed(staff(T), (c) => openOrder(c, { email: contact, name: "Balcão Teste" }));
		expect(result).toMatchObject({ ok: true, state: "awaiting_payment" });
		const [order] = await rows(
			"select mode, client_profile_id, self_research, created_by, subject_name from dossier_orders where dossier_id = $1",
			[result.dossier_id],
		);
		expect(order).toEqual({
			mode: "counter",
			client_profile_id: null,
			self_research: false,
			created_by: T.operator.userId,
			subject_name: "Balcão Teste",
		});
		const [scr] = await rows("select email, client_profile_id, requested_by from scr_authorizations where consultation_id in (select id from consultations where dossier_id = $1)", [
			result.dossier_id,
		]);
		expect(scr).toEqual({ email: contact, client_profile_id: null, requested_by: T.operator.userId });
		const [audit] = await rows("select metadata from audit_logs where action = 'order.open' and record_id = $1", [result.dossier_id]);
		expect(audit.metadata).toEqual({ mode: "counter", product_code: "dossie_pf", members: 1, self_member: false });
	});

	it("staff opens a counter order on a brand-new connection", async () => {
		// Conexão nova: o plpgsql não tem variável de registro aquecida por chamada anterior (v_own nunca atribuída).
		const fresh = new Client({ connectionString: TEST_DATABASE_URL });
		await fresh.connect();
		try {
			await fresh.query("begin");
			await fresh.query(
				`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
                set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
				[T.operator.userId, "operator", T.bureau.id],
			);
			const result = await openOrder(fresh, { email: mail() });
			await fresh.query("commit");
			expect(result).toMatchObject({ ok: true, state: "awaiting_payment" });
		} finally {
			await fresh.end();
		}
	});

	it("staff counter order with a buyer and without a contact when an authorization is usable", async () => {
		const b = await newBuyer(T);
		const document = cpf();
		const first = await committed(staff(T), (c) =>
			openOrder(c, { document, email: mail(), buyer: b.identity.userId }),
		);
		expect(first).toMatchObject({ ok: true, state: "awaiting_payment" });
		const [order] = await rows("select client_profile_id from dossier_orders where dossier_id = $1", [first.dossier_id]);
		expect(order.client_profile_id).toBe(b.identity.userId);
		// Pedido pendente no mesmo escopo dispensa novo contato.
		const second = await committed(staff(T), (c) => openOrder(c, { document, email: null, buyer: b.identity.userId }));
		expect(second.ok).toBe(true);
		// Outro escopo (sem comprador) pede contato.
		const noContact = await committed(staff(T), (c) => openOrder(c, { document, email: null }));
		expect(noContact).toMatchObject({ ok: false, reason: "invalid_input" });
		const selfFlag = await committed(staff(T), (c) => openOrder(c, { self: true, email: mail() }));
		expect(selfFlag).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("buyer of another bureau is buyer_not_found", async () => {
		const other = await committed(staff(T), (c) =>
			openOrder(c, { email: mail(), buyer: U.client.userId }),
		);
		expect(other).toMatchObject({ ok: false, reason: "buyer_not_found" });
		const notClient = await committed(staff(T), (c) =>
			openOrder(c, { email: mail(), buyer: T.bureauAdmin.userId }),
		);
		expect(notClient).toMatchObject({ ok: false, reason: "buyer_not_found" });
		const missing = await committed(staff(T), (c) =>
			openOrder(c, { email: mail(), buyer: randomUUID() }),
		);
		expect(missing).toMatchObject({ ok: false, reason: "buyer_not_found" });
		await asReplica("update profiles set is_active = false where id = $1", [U.client.userId]);
		const inactive = await committed(staff(U), (c) =>
			openOrder(c, { email: mail(), buyer: U.client.userId }),
		);
		expect(inactive).toMatchObject({ ok: false, reason: "buyer_not_found" });
	});

	it("dossie_empresarial creates holders, partnerships and one consultation per partner", async () => {
		const company = cnpj();
		const partnerA = cpf();
		const partnerB = cpf();
		const [companyMail, mailA, mailB] = [mail(), mail(), mail()];
		const result = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				name: "Empresa Completa",
				document: company,
				email: companyMail,
				partners: [
					{ document: partnerA, name: "Sócia Um", email: mailA, percentage: 60, role: "Administradora" },
					{ document: partnerB, name: "Sócio Dois", email: mailB, percentage: 40 },
					{ document: partnerA, name: "Sócia Um Repetida", email: mail() },
				],
			}),
		);
		expect(result).toMatchObject({ ok: true, state: "awaiting_payment" });
		const [dossier] = await rows<{ holder_id: string; kind: string; product: string }>(
			"select holder_id, kind, product from dossiers where id = $1",
			[result.dossier_id],
		);
		expect(dossier).toMatchObject({ kind: "PJ_FULL", product: await depsProduct("dossie_empresarial") });
		const partnerships = await rows(
			`select h.document_digits, p.percentage::text as percentage, p.role, p.source, p.created_by
         from holder_partnerships p join holders h on h.id = p.partner_id where p.company_id = $1 order by h.document_digits`,
			[dossier.holder_id],
		);
		expect(partnerships).toHaveLength(2);
		expect(partnerships).toEqual(
			expect.arrayContaining([
				{ document_digits: partnerA, percentage: "60.00", role: "Administradora", source: "operator", created_by: T.operator.userId },
				{ document_digits: partnerB, percentage: "40.00", role: null, source: "operator", created_by: T.operator.userId },
			]),
		);
		const consultations = await rows<{ type: string; product: string; scr_email: string; document: string }>(
			"select type, product, scr_email, document from consultations where dossier_id = $1 order by created_at, document",
			[result.dossier_id],
		);
		expect(consultations).toHaveLength(3);
		const byDocument = Object.fromEntries(consultations.map((r) => [r.document, r]));
		expect(byDocument[company]).toMatchObject({ type: "PJ", product: await depsProduct("dossie_empresarial"), scr_email: companyMail });
		expect(byDocument[partnerA]).toMatchObject({ type: "PF", product: await depsProduct("dossie_pf"), scr_email: mailA });
		// Cada sócio tem o próprio e-mail: o contato da empresa nunca vale por ele (D9).
		expect(byDocument[partnerB]).toMatchObject({ type: "PF", scr_email: mailB });
		expect(await rows("select 1 from scr_authorizations where holder_id in (select holder_id from consultations where dossier_id = $1)", [result.dossier_id])).toHaveLength(3);
		const [audit] = await rows("select metadata from audit_logs where action = 'order.open' and record_id = $1", [result.dossier_id]);
		expect(audit.metadata).toMatchObject({ mode: "counter", product_code: "dossie_empresarial", members: 3, self_member: false });
	});

	it("a refusal after the first write undoes holders and dossier", async () => {
		const company = cnpj();
		const partner = cpf();
		// Sem contato principal e sem autorização prévia: a recusa vem depois de Titular e Dossiê gravados.
		const result = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: company,
				email: null,
				partners: [{ document: partner, name: "Sócio", email: mail() }],
			}),
		);
		expect(result).toMatchObject({ ok: false, reason: "invalid_input", dossier_id: null });
		expect(await rows("select 1 from holders where bureau_id = $1 and document_digits = any($2::text[])", [T.bureau.id, [company, partner]])).toHaveLength(0);
	});

	it("dossie_empresarial refuses a partner equal to the company, a CNPJ partner or bad data", async () => {
		const company = cnpj();
		const bad = [
			[{ document: company, name: "Mesma Empresa", email: mail() }],
			// Sócio é sempre CPF: 14 dígitos recusa.
			[{ document: cnpj(), name: "Holding", email: mail() }],
			[{ document: cpf(), name: "" }],
			[{ document: "123", name: "Curto" }],
			[{ document: cpf(), name: "Sócio", email: "sem-arroba" }],
			// D9: sócio sem e-mail próprio não herda o da empresa.
			[{ document: cpf(), name: "Sócio sem e-mail" }],
			[{ document: cpf(), name: "Sócio e-mail vazio", email: "  " }],
		];
		for (const partners of bad) {
			const result = await committed(staff(T), (c) =>
				openOrder(c, { product: "dossie_empresarial", type: "PJ", document: company, email: mail(), partners }),
			);
			expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		expect(await rows("select 1 from holders where bureau_id = $1 and document_digits = $2", [T.bureau.id, company])).toHaveLength(0);
	});
});

describe("settlement and state refresh", () => {
	it("reserve_order accepts the buyer third party order and refuses another client", async () => {
		const buyer = await newBuyer(T, "PJ");
		const other = await newBuyer(T);
		await seedClientWalletTopup(owner, { clientProfileId: buyer.identity.userId, amount: "100.00", createdBy: T.bureauAdmin.userId });
		const placed = await committed(buyer.identity, (c) => openOrder(c, { email: mail() }));
		const reserve = (c: PoolClient, who: Identity) =>
			c
				.query("select * from reserve_order($1, 'online', $2, 50.00, 0, $3::jsonb)", [
					placed.dossier_id,
					who.userId,
					QUOTE("dossie_pf"),
				])
				.then((r) => r.rows[0]);
		const refused = await committed(other.identity, (c) => reserve(c, other.identity));
		expect(refused).toMatchObject({ ok: false, reason: "not_found" });
		const accepted = await committed(buyer.identity, (c) => reserve(c, buyer.identity));
		expect(accepted).toMatchObject({ ok: true, status: "reserved" });
		// Pedido de balcão não serve ao modo online, nem o online ao balcão.
		const counter = await committed(staff(T), (c) => openOrder(c, { email: mail() }));
		const wrongMode = await committed(buyer.identity, (c) =>
			c
				.query("select * from reserve_order($1, 'online', $2, 50.00, 0, $3::jsonb)", [counter.dossier_id, buyer.identity.userId, QUOTE("dossie_pf")])
				.then((r) => r.rows[0]),
		);
		expect(wrongMode).toMatchObject({ ok: false, reason: "not_found" });
		const counterOnOnline = await committed(staff(T), (c) =>
			c
				.query("select * from reserve_order($1, 'counter', null, 50.00, 1.00, $2::jsonb)", [placed.dossier_id, QUOTE("dossie_pf")])
				.then((r) => r.rows[0]),
		);
		expect(counterOnOnline).toMatchObject({ ok: false, reason: "not_found" });
	});

	it("refresh_order_state follows payments and authorizations", async () => {
		const R = await newTenant("ord refresh", { dossie_pf: "0.30" }, "0.10");
		await seedWalletTopup(owner, { bureauId: R.bureau.id, amount: "10.00", createdBy: R.bureauAdmin.userId });
		const placed = await committed(staff(R), (c) => openOrder(c, { email: mail() }));
		const dossierId = placed.dossier_id as string;
		const reserved = await committed(staff(R), (c) =>
			c
				.query("select * from reserve_order($1, 'counter', null, 0.30, 0.10, $2::jsonb)", [dossierId, QUOTE("dossie_pf")])
				.then((r) => r.rows[0]),
		);
		expect(reserved.ok).toBe(true);
		const refresh = () => committed(staff(R), (c) => c.query<{ s: string }>("select refresh_order_state($1) as s", [dossierId]).then((r) => r.rows[0].s));
		const pay = (amount: string) =>
			owner.query<{ id: string }>(
				`insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by)
         values ($1, $2, 'cash', $3, $4) returning id`,
				[R.bureau.id, dossierId, amount, R.operator.userId],
			);
		const stateOf = async () => (await rows<{ state: string }>("select state from dossier_orders where dossier_id = $1", [dossierId]))[0].state;

		expect(await refresh()).toBe("awaiting_payment");
		await pay("0.10");
		expect(await refresh()).toBe("awaiting_payment");
		const second = await pay("0.20");
		expect(await refresh()).toBe("awaiting_authorization");
		expect(await stateOf()).toBe("awaiting_authorization");
		await owner.query(
			"update counter_payments set voided_at = now(), voided_by = $2, void_reason = 'erro' where id = $1",
			[second.rows[0].id, R.operator.userId],
		);
		expect(await refresh()).toBe("awaiting_payment");
		await pay("0.20");
		expect(await refresh()).toBe("awaiting_authorization");

		const [holder] = await rows<{ holder_id: string }>("select holder_id from dossiers where id = $1", [dossierId]);
		await authorize(holder.holder_id);
		expect(await refresh()).toBe("ready");
		await owner.query("update scr_authorizations set expires_at = now() - interval '1 minute' where holder_id = $1", [holder.holder_id]);
		expect(await refresh()).toBe("awaiting_authorization");
	});

	it("refresh_order_state treats a member without a linked authorization as unauthorized", async () => {
		const placed = await committed(staff(T), (c) =>
			openOrder(c, {
				product: "dossie_empresarial",
				type: "PJ",
				document: cnpj(),
				email: mail(),
				partners: [{ document: cpf(), name: "Sócio", email: mail() }],
			}),
		);
		const dossierId = placed.dossier_id as string;
		await owner.query(
			"insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 1.00, 0.00)",
			[dossierId, T.bureau.id],
		);
		await owner.query(
			"insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by) values ($1, $2, 'cash', 1.00, $3)",
			[T.bureau.id, dossierId, T.operator.userId],
		);
		await owner.query("update consultations set scr_authorization_id = null where dossier_id = $1 and type = 'PF'", [dossierId]);
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days'
        where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[dossierId],
		);
		const state = await committed(staff(T), (c) => c.query<{ s: string }>("select refresh_order_state($1) as s", [dossierId]).then((r) => r.rows[0].s));
		expect(state).toBe("awaiting_authorization");
	});

	it("refresh_order_state returns null for an unknown order", async () => {
		const missing = await committed(staff(T), (c) => c.query("select refresh_order_state($1) as s", [randomUUID()]).then((r) => r.rows[0].s));
		expect(missing).toBeNull();
	});
});

describe("dossier_orders_guard", () => {
	async function counterOrder() {
		const placed = await committed(staff(T), (c) => openOrder(c, { email: mail() }));
		return placed.dossier_id as string;
	}
	const setState = (id: string, state: string, extra = "") =>
		owner.query(`update dossier_orders set state = $2::text ${extra} where dossier_id = $1`, [id, state]);
	const refused = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "23514" });

	it("refuses transitions outside the table and immutable column changes", async () => {
		const id = await counterOrder();
		await setState(id, "ready");
		await setState(id, "executing");
		await setState(id, "failed");
		await refused(setState(id, "ready"));
		await refused(setState(id, "cancelled"));

		const released = await counterOrder();
		await setState(released, "ready");
		await setState(released, "executing");
		await setState(released, "completed");
		await refused(setState(released, "released")); // released_at é obrigatório
		await owner.query(
			"update dossier_orders set state = 'released', released_at = now(), released_by = $2 where dossier_id = $1",
			[released, T.operator.userId],
		);
		await refused(setState(released, "executing"));
		await setState(released, "completed");

		await refused(owner.query("update dossier_orders set client_profile_id = $2 where dossier_id = $1", [released, T.client.userId]));
		await refused(owner.query("update dossier_orders set mode = 'online' where dossier_id = $1", [released]));
		await refused(owner.query("update dossier_orders set subject_name = 'Outro' where dossier_id = $1", [released]));
		await refused(owner.query("delete from dossier_orders where dossier_id = $1", [released]));
		// TRUNCATE trava a tabela inteira e bloquearia os outros arquivos em paralelo: confere só o gatilho.
		const truncateGuard = await rows(
			"select 1 from pg_trigger where tgrelid = 'dossier_orders'::regclass and tgname = 'dossier_orders_no_truncate' and not tgisinternal",
			[],
		);
		expect(truncateGuard).toHaveLength(1);
	});

	it("allows the table's own moves and mutable columns", async () => {
		const id = await counterOrder();
		await setState(id, "awaiting_authorization");
		await setState(id, "awaiting_payment");
		await setState(id, "ready");
		await owner.query("update dossier_orders set attempts = 1, next_attempt_at = now(), lease_until = now() where dossier_id = $1", [id]);
		await setState(id, "awaiting_authorization");
		await setState(id, "cancelled", ", state_reason = 'payment_timeout'");
		await refused(setState(id, "ready"));
	});

	it("guard still refuses subject_name changes other than anonymization", async () => {
		const id = await counterOrder();
		await refused(owner.query("update dossier_orders set subject_name = 'X' where dossier_id = $1", [id]));
		// A exceção vale só para o texto fixo da anonimização e não abre as outras colunas.
		await refused(
			owner.query("update dossier_orders set subject_name = 'Titular anonimizado', mode = 'online' where dossier_id = $1", [id]),
		);
		await owner.query("update dossier_orders set subject_name = 'Titular anonimizado' where dossier_id = $1", [id]);
		const [row] = await rows<{ subject_name: string }>("select subject_name from dossier_orders where dossier_id = $1", [id]);
		expect(row.subject_name).toBe("Titular anonimizado");
	});
});

describe("public SCR confirmation with a request deadline", () => {
	async function pendingRequest() {
		const b = await newBuyer(T);
		await committed(b.identity, (c) => openOrder(c, { self: true }));
		const [scr] = await rows<{ id: string; public_token: string }>(
			"select id, public_token from scr_authorizations where holder_id = $1",
			[b.holderId],
		);
		await owner.query("update scr_authorizations set auth_code = 'ABC123' where id = $1", [scr.id]);
		return { ...b, scr };
	}
	const confirm = (token: string, decision = "authorize", code = "ABC123") =>
		app.query<{ r: string }>("select confirm_public_scr_authorization($1, 'internal', $2, $3, '203.0.113.9') as r", [token, code, decision]).then((r) => r.rows[0].r);

	it("expired request answers expired", async () => {
		const p = await pendingRequest();
		await owner.query("update scr_authorizations set request_expires_at = now() - interval '1 minute' where id = $1", [p.scr.id]);
		expect(await confirm(p.scr.public_token)).toBe("expired");
		const [row] = await rows("select status, auth_code, authorized_at from scr_authorizations where id = $1", [p.scr.id]);
		expect(row).toEqual({ status: "expired", auth_code: null, authorized_at: null });
		const events = await rows("select title from timeline_events where entity_id = $1 and event_type = 'scr.expired'", [p.holderId]);
		expect(events).toEqual([{ title: "Pedido de autorização SCR expirado" }]);
		// Linha que já está expirada continua respondendo expired, sem novo evento.
		expect(await confirm(p.scr.public_token)).toBe("expired");
		expect(await confirm(p.scr.public_token, "refuse")).toBe("expired");
		expect(await rows("select 1 from timeline_events where entity_id = $1 and event_type = 'scr.expired'", [p.holderId])).toHaveLength(1);
	});

	it("request inside the deadline authorizes as before", async () => {
		const p = await pendingRequest();
		await owner.query("update scr_authorizations set request_expires_at = now() + interval '7 days' where id = $1", [p.scr.id]);
		expect(await confirm(p.scr.public_token, "authorize", "WRONG1")).toBe("invalid_code");
		expect(await confirm(p.scr.public_token)).toBe("authorized");
		expect(await confirm(p.scr.public_token)).toBe("already");
	});

	it("request without a deadline still authorizes", async () => {
		const p = await pendingRequest();
		expect(await confirm(p.scr.public_token)).toBe("authorized");
	});
});

describe("system profile per bureau", () => {
	it("system profile is created for a new bureau and backfilled", async () => {
		const [bureau] = await rows<{ id: string }>(
			"insert into bureaus (name, slug) values ('Sistema Teste', $1) returning id",
			[`sys-${randomUUID().slice(0, 8)}`],
		);
		bureauIds.push(bureau.id);
		const profiles = await rows<{ id: string; role: string; full_name: string; is_active: boolean; email: string }>(
			"select id, role, full_name, is_active, email from profiles where bureau_id = $1 and is_system",
			[bureau.id],
		);
		expect(profiles).toHaveLength(1);
		expect(profiles[0]).toMatchObject({ role: "operator", full_name: "Sistema", is_active: true });
		expect(profiles[0].email).toBe(`sistema+${bureau.id}@sistema.invalid`);
		// Backfill e gatilho: nenhum Bureau fica sem o perfil.
		expect(
			await rows(
				"select b.id from bureaus b where not exists (select 1 from profiles p where p.bureau_id = b.id and p.is_system)",
				[],
			),
		).toHaveLength(0);
		const insertProfile = async (role: string) => {
			const id = randomUUID();
			await owner.query(`insert into "user" (id, name, email) values ($1, 'Outro', $2)`, [id, `outro-${id}@example.test`]);
			return owner.query(
				`insert into profiles (id, auth_user_id, full_name, email, role, bureau_id, is_system)
         values ($1::uuid, $1::text, 'Outro', $2, $3::user_role, $4, true)`,
				[id, `outro-${id}@example.test`, role, bureau.id],
			);
		};
		await expect(insertProfile("client")).rejects.toMatchObject({ code: "23514" });
		await expect(insertProfile("operator")).rejects.toMatchObject({ code: "23505" });
	});

	it("system profile has no account and no session lookup", async () => {
		const [system] = await rows<{ id: string }>("select id from profiles where bureau_id = $1 and is_system", [T.bureau.id]);
		expect(await rows("select 1 from account where user_id = $1", [system.id])).toHaveLength(0);
		const [user] = await rows<{ name: string; email_verified: boolean }>('select name, email_verified from "user" where id = $1', [system.id]);
		expect(user).toEqual({ name: "Sistema", email_verified: true });
		const lookup = await app.query("select * from auth_profile_for_session($1)", [system.id]);
		expect(lookup.rows).toHaveLength(0);
		const regular = await app.query("select user_id from auth_profile_for_session($1)", [T.operator.userId]);
		expect(regular.rows).toHaveLength(1);
	});
});

describe("admin_set_credentials and the system profile", () => {
	it("admin_set_credentials refuses the system profile", async () => {
		const [system] = await rows<{ id: string }>("select id from profiles where bureau_id = $1 and is_system", [T.bureau.id]);
		const call = (actor: Identity | { userId: string; role: string; bureauId: null }) =>
			committed(actor, (c) =>
				c
					.query<{ ok: boolean }>("select admin_set_credentials($1::uuid, $2::uuid, $3) as ok", [system.id, T.bureau.id, "x".repeat(40)])
					.then((r) => r.rows[0].ok),
			);
		expect(await call(T.bureauAdmin)).toBe(false);
		expect(await rows("select 1 from account where user_id = $1", [system.id])).toHaveLength(0);
		expect((await rows("select must_change_password from profiles where id = $1", [system.id]))[0]).toEqual({ must_change_password: false });
		// O operador comum do mesmo Bureau segue como alvo válido.
		expect(
			await committed(T.bureauAdmin, (c) =>
				c
					.query<{ ok: boolean }>("select admin_set_credentials($1::uuid, $2::uuid, $3) as ok", [T.operator.userId, T.bureau.id, "x".repeat(40)])
					.then((r) => r.rows[0].ok),
			),
		).toBe(true);
	});
});

describe("due_order_bureaus", () => {
	const due = async () =>
		new Map(
			(await app.query<{ bureau_id: string; system_profile_id: string }>("select * from due_order_bureaus()")).rows.map((r) => [
				r.bureau_id,
				r.system_profile_id,
			]),
		);
	const systemId = async (bureauId: string) =>
		(await rows<{ id: string }>("select id from profiles where bureau_id = $1 and is_system", [bureauId]))[0].id;

	it("lists only bureaus with due work", async () => {
		const idle = await newTenant("due idle");
		const waiting = await newTenant("due waiting");
		const counter = await newTenant("due counter");
		const inactive = await newTenant("due inactive");
		const expiring = await newTenant("due expiring");

		await committed((await newBuyer(waiting)).identity, (c) => openOrder(c, { self: true }));
		await committed(staff(counter), (c) => openOrder(c, { email: mail() }));
		await committed((await newBuyer(inactive)).identity, (c) => openOrder(c, { self: true }));
		await owner.query("update bureaus set status = 'inactive' where id = $1", [inactive.bureau.id]);
		await owner.query(
			`insert into scr_authorizations (bureau_id, document, type, holder_id, channel, status, request_expires_at)
       values ($1, $2, 'PF', $3, 'internal', 'pending', now() - interval '1 hour')`,
			[expiring.bureau.id, expiring.holder.document, expiring.holder.id],
		);

		const first = await due();
		expect(first.has(idle.bureau.id)).toBe(false);
		expect(first.get(waiting.bureau.id)).toBe(await systemId(waiting.bureau.id));
		// Balcão sem pagamento com menos de 7 dias ainda não vence.
		expect(first.has(counter.bureau.id)).toBe(false);
		expect(first.has(inactive.bureau.id)).toBe(false);
		expect(first.get(expiring.bureau.id)).toBe(await systemId(expiring.bureau.id));

		const dossier = await seedDossier(owner, { bureauId: counter.bureau.id, holderId: counter.holder.id, createdBy: counter.bureauAdmin.userId });
		await owner.query(
			`insert into dossier_orders (dossier_id, bureau_id, mode, product_code, subject_name, subject_document_masked, state, created_by, created_at)
       values ($1, $2, 'counter', 'dossie_pf', 'Antigo', '***.000.000-**', 'awaiting_payment', $3, now() - interval '8 days')`,
			[dossier, counter.bureau.id, counter.bureauAdmin.userId],
		);
		expect((await due()).has(counter.bureau.id)).toBe(true);
	});

	it("covers ready, executing and completed work", async () => {
		// [estado, colunas extras, modo, vence?]
		const cases: [string, string, "online" | "counter", boolean][] = [
			["ready", "next_attempt_at = null", "online", true],
			["ready", "next_attempt_at = now() - interval '1 minute'", "counter", true],
			["ready", "next_attempt_at = now() + interval '1 hour'", "online", false],
			["executing", "lease_until = now() - interval '1 minute'", "online", true],
			["executing", "lease_until = null", "online", true],
			["executing", "lease_until = now() + interval '5 minutes'", "online", false],
			["completed", "ai_status = 'pending'", "counter", true],
			["completed", "ai_status = 'done'", "online", true],
			["completed", "ai_status = 'done'", "counter", false],
			["released", "ai_status = 'done'", "online", false],
			["failed", "ai_status = 'failed'", "online", false],
			["cancelled", "ai_status = 'done'", "counter", false],
		];
		for (const [state, set, mode, expected] of cases) {
			const t = await newTenant(`due ${state}`);
			const dossier = await seedDossier(owner, { bureauId: t.bureau.id, holderId: t.holder.id, createdBy: t.bureauAdmin.userId });
			await owner.query(
				`insert into dossier_orders (dossier_id, bureau_id, mode, client_profile_id, product_code, subject_name,
           subject_document_masked, state, released_at, created_by)
         values ($1, $2, $3, $4, 'dossie_pf', 'Pedido', '***.000.000-**', $5, case when $5 = 'released' then now() end, $6)`,
				[dossier, t.bureau.id, mode, mode === "online" ? t.client.userId : null, state, t.bureauAdmin.userId],
			);
			await owner.query(`update dossier_orders set ${set} where dossier_id = $1`, [dossier]);
			expect([state, set, mode, (await due()).has(t.bureau.id)]).toEqual([state, set, mode, expected]);
		}
	});

	it("returns only ids", async () => {
		const result = await app.query("select * from due_order_bureaus() limit 1");
		expect(result.fields.map((f) => f.name)).toEqual(["bureau_id", "system_profile_id"]);
	});
});

describe("notification templates (022)", () => {
	it("new templates are active", async () => {
		const found = await rows<{ key: string; channel: string; version: number; status: string; params: string[]; wa_template_name: string | null; wa_language: string | null; email_subject: string | null }>(
			`select key, channel, version, status, params, wa_template_name, wa_language, email_subject
         from notification_templates where key in ('scr_authorization', 'research_released') and channel <> 'push' and status = 'active' order by key, channel`,
			[],
		);
		expect(found).toEqual([
			{ key: "research_released", channel: "email", version: 3, status: "active", params: ["clientName", "url"], wa_template_name: null, wa_language: null, email_subject: "Sua pesquisa está disponível" },
			{ key: "research_released", channel: "whatsapp", version: 1, status: "active", params: ["clientName", "url"], wa_template_name: "research_released", wa_language: "pt_BR", email_subject: null },
			{ key: "scr_authorization", channel: "email", version: 3, status: "active", params: ["clientName", "authorizedName", "code", "url"], wa_template_name: null, wa_language: null, email_subject: "Autorização de consulta SCR — Rainha Cred" },
			{ key: "scr_authorization", channel: "whatsapp", version: 1, status: "active", params: ["clientName", "authorizedName", "code", "url"], wa_template_name: "scr_authorization", wa_language: "pt_BR", email_subject: null },
		]);
	});

	it("research_released e-mail has the placeholders and no stray marker", async () => {
		const [tpl] = await rows<{ email_html: string; email_text: string }>(
			"select email_html, email_text from notification_templates where key = 'research_released' and channel = 'email' and status = 'active'",
			[],
		);
		for (const body of [tpl.email_html, tpl.email_text]) {
			expect(body).toContain("{{clientName}}");
			expect(body).toContain("{{url}}");
			expect((body.match(/\{\{\w+\}\}/g) ?? []).every((m) => ["{{clientName}}", "{{url}}", "{{siteUrl}}"].includes(m))).toBe(true);
		}
	});
});
