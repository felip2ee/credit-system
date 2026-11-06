// Dados do dono da carteira que paga (cliente ou Bureau). Spec: docs/superpowers/specs/2026-11-06-pagamento-por-pagador-design.md.
// Documento, CEP e número ficam só cifrados em payer_profiles.pii_ciphertext (AES-256-GCM, src/lib/pii). A tela lê as
// máscaras (sem decifrar). Só loadOwnerPayerForCharge e saveOwnerPayer tocam no valor completo, e só com a identidade do dono.
// Nenhum PoolClient sai deste módulo. Nenhum erro, log ou auditoria leva documento, CEP, número ou chave.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { maskRecipient } from "@/lib/auth/email";
import type { PiiKeyring } from "@/lib/config";
import type { DbIdentity } from "@/lib/db/transaction";
import { maskPayerDocument, maskPhone, maskPostalCode } from "@/lib/mask-document";
import { decryptPayerPii, encryptPayerPii, PiiDecryptError, type PayerPii } from "@/lib/pii/crypto";
import { addressNumberSchema, cpfCnpjSchema, payerFieldsSchema, postalCodeSchema } from "@/lib/validators/payer";
import type { ChargeScope } from "@/lib/wallet/pix-charges";

export type PayerScope = ChargeScope;
export type PayerField = "name" | "document" | "email" | "phone" | "postalCode" | "addressNumber";

// Só máscaras: é o que a tela do checkout mostra.
export type OwnerPayerView = {
	name: string | null;
	emailMasked: string;
	phoneMasked: string | null;
	documentMasked: string | null;
	postalCodeMasked: string | null;
	hasAddressNumber: boolean;
	source: "payer_profile" | "holder" | "none";
};

export type ResolvedPayer = {
	name: string;
	cpfCnpj: string;
	email: string;
	phone: string | null;
	postalCode: string | null;
	addressNumber: string | null;
};

type PayerRow = {
	id: string;
	name: string | null;
	email: string | null;
	phone_e164: string | null;
	pii_ciphertext: Buffer;
	pii_key_id: string;
	document_masked: string | null;
	postal_code_masked: string | null;
	has_address_number: boolean;
	asaas_customer_id: string | null;
	asaas_customer_owned: boolean;
	asaas_customer_stale: boolean;
};

const ROW_COLUMNS = `id, name, email, phone_e164, pii_ciphertext, pii_key_id, document_masked, postal_code_masked,
	has_address_number, asaas_customer_id, asaas_customer_owned, asaas_customer_stale`;

// O escopo precisa ser o do próprio solicitante: o cliente paga para a própria carteira, o Bureau para a dele.
function assertOwnScope(identity: DbIdentity, scope: PayerScope): void {
	const ok =
		scope.kind === "client"
			? identity.role === "client" && identity.userId === scope.clientProfileId
			: identity.bureauId !== null && identity.bureauId === scope.bureauId;
	if (!ok || !identity.bureauId) throw new Error("payer scope mismatch");
}

// AAD: o blob só decifra na linha para a qual foi cifrado.
function payerAad(identity: DbIdentity, scope: PayerScope): string {
	return `payer:${identity.bureauId}:${scope.kind === "client" ? scope.clientProfileId : "bureau"}`;
}

async function lockPayer(client: PoolClient, aad: string): Promise<void> {
	await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`payer-profile:${aad}`]);
}

async function selectRow(client: PoolClient, scope: PayerScope, forUpdate: boolean): Promise<PayerRow | null> {
	const where = scope.kind === "client" ? "client_profile_id = $1" : "bureau_id = $1 and client_profile_id is null";
	const { rows } = await client.query<PayerRow>(
		`select ${ROW_COLUMNS} from payer_profiles where ${where}${forUpdate ? " for update" : ""}`,
		[scope.kind === "client" ? scope.clientProfileId : scope.bureauId],
	);
	return rows[0] ?? null;
}

type AccountProfile = { fullName: string | null; email: string | null; phoneE164: string | null };

async function readAccountProfile(client: PoolClient, userId: string): Promise<AccountProfile> {
	const { rows } = await client.query<{ full_name: string | null; email: string | null; phone_e164: string | null }>(
		"select full_name, email, phone_e164 from profiles where id = $1",
		[userId],
	);
	const row = rows[0];
	return { fullName: row?.full_name ?? null, email: row?.email ?? null, phoneE164: row?.phone_e164 ?? null };
}

// D8: dado conhecido do Titular próprio do cliente (documento, CEP, número). Valor que não passa na validação não vale.
async function readHolderKnown(client: PoolClient, clientProfileId: string): Promise<PayerPii> {
	const { rows } = await client.query<{ document: string; zip_code: string | null; address_number: string | null }>(
		`select document, zip_code, address_number from holders
		  where client_profile_id = $1 and anonymized_at is null order by created_at limit 1`,
		[clientProfileId],
	);
	const row = rows[0];
	if (!row) return {};
	const document = cpfCnpjSchema.safeParse(row.document);
	const postalCode = postalCodeSchema.safeParse(row.zip_code ?? "");
	const addressNumber = addressNumberSchema.safeParse(row.address_number ?? "");
	return {
		...(document.success ? { document: document.data } : {}),
		...(postalCode.success ? { postalCode: postalCode.data } : {}),
		...(addressNumber.success ? { addressNumber: addressNumber.data } : {}),
	};
}

function compact(pii: PayerPii): PayerPii {
	return Object.fromEntries(Object.entries(pii).filter(([, value]) => value !== undefined)) as PayerPii;
}

export async function getOwnerPayerView(
	client: PoolClient,
	identity: DbIdentity,
	scope: PayerScope,
): Promise<OwnerPayerView> {
	assertOwnScope(identity, scope);
	const [row, account] = await Promise.all([
		selectRow(client, scope, false),
		readAccountProfile(client, identity.userId),
	]);
	const emailMasked = maskRecipient(row?.email ?? account.email ?? "");
	const phone = row?.phone_e164 ?? account.phoneE164;
	const phoneMasked = phone ? maskPhone(phone) : null;
	const name = row?.name ?? (scope.kind === "client" ? account.fullName : null);

	if (row) {
		return {
			name,
			emailMasked,
			phoneMasked,
			documentMasked: row.document_masked,
			postalCodeMasked: row.postal_code_masked,
			hasAddressNumber: row.has_address_number,
			source: "payer_profile",
		};
	}
	const known = scope.kind === "client" ? await readHolderKnown(client, scope.clientProfileId) : {};
	const hasKnown = Boolean(known.document || known.postalCode || known.addressNumber);
	return {
		name,
		emailMasked,
		phoneMasked,
		documentMasked: known.document ? maskPayerDocument(known.document) : null,
		postalCodeMasked: known.postalCode ? maskPostalCode(known.postalCode) : null,
		hasAddressNumber: Boolean(known.addressNumber),
		source: hasKnown ? "holder" : "none",
	};
}

// Mescla o patch com o dado atual (decifrado), cifra com a chave ativa e grava as máscaras. Documento novo zera o
// cliente Asaas; outro campo novo marca o cliente como desatualizado. Sem mudança, não grava. Blob ilegível (chave
// perdida): recomeça do patch, o dono digita de novo (spec, R10).
export async function saveOwnerPayer(
	client: PoolClient,
	identity: DbIdentity,
	scope: PayerScope,
	patch: Partial<Record<PayerField, string>>,
	keyring: PiiKeyring,
): Promise<{ ok: true } | { ok: false; reason: "invalid" }> {
	assertOwnScope(identity, scope);
	const parsed = payerFieldsSchema.safeParse(patch);
	if (!parsed.success) return { ok: false, reason: "invalid" };
	const next = parsed.data;

	const aad = payerAad(identity, scope);
	await lockPayer(client, aad);
	const row = await selectRow(client, scope, true);

	let current: PayerPii = {};
	if (row) {
		try {
			current = decryptPayerPii(keyring, aad, row.pii_ciphertext, row.pii_key_id);
		} catch (error) {
			if (!(error instanceof PiiDecryptError)) throw error;
		}
	}

	const changed: PayerField[] = [];
	if (next.name !== undefined && next.name !== row?.name) changed.push("name");
	if (next.document !== undefined && next.document !== current.document) changed.push("document");
	if (next.email !== undefined && next.email !== row?.email) changed.push("email");
	if (next.phone !== undefined && next.phone !== row?.phone_e164) changed.push("phone");
	if (next.postalCode !== undefined && next.postalCode !== current.postalCode) changed.push("postalCode");
	if (next.addressNumber !== undefined && next.addressNumber !== current.addressNumber) changed.push("addressNumber");
	if (changed.length === 0) return { ok: true };

	const pii = compact({
		document: next.document ?? current.document,
		postalCode: next.postalCode ?? current.postalCode,
		addressNumber: next.addressNumber ?? current.addressNumber,
	});
	const { ciphertext, keyId } = encryptPayerPii(keyring, aad, pii);
	const documentMasked = pii.document ? maskPayerDocument(pii.document) : null;
	const postalCodeMasked = pii.postalCode ? maskPostalCode(pii.postalCode) : null;
	const values = [
		next.name ?? row?.name ?? null,
		next.email ?? row?.email ?? null,
		next.phone ?? row?.phone_e164 ?? null,
		ciphertext,
		keyId,
		documentMasked,
		postalCodeMasked,
		Boolean(pii.addressNumber),
	];

	let payerId: string;
	if (row) {
		const documentChanged = changed.includes("document");
		await client.query(
			`update payer_profiles set name = $2, email = $3, phone_e164 = $4, pii_ciphertext = $5, pii_key_id = $6,
			        document_masked = $7, postal_code_masked = $8, has_address_number = $9,
			        asaas_customer_id = $10, asaas_customer_owned = $11, asaas_customer_stale = $12
			  where id = $1`,
			[
				row.id,
				...values,
				documentChanged ? null : row.asaas_customer_id,
				documentChanged ? false : row.asaas_customer_owned,
				documentChanged ? false : row.asaas_customer_stale || changed.length > 0,
			],
		);
		payerId = row.id;
	} else {
		const { rows } = await client.query<{ id: string }>(
			`insert into payer_profiles (bureau_id, client_profile_id, name, email, phone_e164, pii_ciphertext, pii_key_id,
			        document_masked, postal_code_masked, has_address_number)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
			[identity.bureauId, scope.kind === "client" ? scope.clientProfileId : null, ...values],
		);
		payerId = rows[0].id;
	}

	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: "payer.update",
		targetTable: "payer_profiles",
		targetId: payerId,
		// Não chama "documentMasked": redact() apagaria a máscara de toda chave com "document".
		metadata: { fields: changed, payerMask: documentMasked },
	});
	return { ok: true };
}

export type OwnerPayerForCharge = {
	payer: Partial<ResolvedPayer>;
	payerProfileId: string | null;
	asaasCustomerId: string | null;
	owned: boolean;
	stale: boolean;
};

// Dado completo do dono para a cobrança (a única leitura em claro). Linha com chave antiga é recifrada com a ativa na
// mesma transação. Sem linha, o cliente usa o Titular próprio (D8): a cópia cifrada é feita por saveOwnerPayer (T5).
// Blob ilegível lança PiiDecryptError (mensagem fixa): quem chama devolve erro seguro.
export async function loadOwnerPayerForCharge(
	client: PoolClient,
	identity: DbIdentity,
	scope: PayerScope,
	keyring: PiiKeyring,
): Promise<OwnerPayerForCharge> {
	assertOwnScope(identity, scope);
	const aad = payerAad(identity, scope);
	const account = await readAccountProfile(client, identity.userId);
	let row = await selectRow(client, scope, false);

	if (!row) {
		const known = scope.kind === "client" ? await readHolderKnown(client, scope.clientProfileId) : {};
		return {
			payer: withoutNulls({
				name: scope.kind === "client" ? account.fullName : null,
				cpfCnpj: known.document,
				email: account.email,
				phone: account.phoneE164,
				postalCode: known.postalCode,
				addressNumber: known.addressNumber,
			}),
			payerProfileId: null,
			asaasCustomerId: null,
			owned: false,
			stale: false,
		};
	}

	let pii: PayerPii;
	if (row.pii_key_id !== keyring.activeKeyId) {
		await lockPayer(client, aad);
		// Outra transação pode ter salvo ou recifrado enquanto esperávamos o lock.
		row = (await selectRow(client, scope, true)) ?? row;
		pii = decryptPayerPii(keyring, aad, row.pii_ciphertext, row.pii_key_id);
		if (row.pii_key_id !== keyring.activeKeyId) {
			const { ciphertext, keyId } = encryptPayerPii(keyring, aad, pii);
			await client.query("update payer_profiles set pii_ciphertext = $2, pii_key_id = $3 where id = $1", [
				row.id,
				ciphertext,
				keyId,
			]);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "payer.rekey",
				targetTable: "payer_profiles",
				targetId: row.id,
				metadata: { toKeyId: keyId },
			});
		}
	} else {
		pii = decryptPayerPii(keyring, aad, row.pii_ciphertext, row.pii_key_id);
	}

	return {
		payer: withoutNulls({
			name: row.name ?? (scope.kind === "client" ? account.fullName : null),
			cpfCnpj: pii.document,
			email: row.email ?? account.email,
			phone: row.phone_e164 ?? account.phoneE164,
			postalCode: pii.postalCode,
			addressNumber: pii.addressNumber,
		}),
		payerProfileId: row.id,
		asaasCustomerId: row.asaas_customer_id,
		owned: row.asaas_customer_owned,
		stale: row.asaas_customer_stale,
	};
}

function withoutNulls(values: Record<string, string | null | undefined>): Partial<ResolvedPayer> {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null)) as Partial<ResolvedPayer>;
}

// Grava o cliente Asaas do dono só se a linha ainda não tem um. Devolve o id vencedor: se outra requisição ganhou, o
// UPDATE espera o lock dela, não casa mais com "is null" e lemos o id dela. O cliente criado a mais fica órfão no Asaas.
export async function claimAsaasCustomer(
	client: PoolClient,
	payerProfileId: string,
	asaasCustomerId: string,
	owned: boolean,
): Promise<string> {
	const claimed = await client.query<{ asaas_customer_id: string }>(
		`update payer_profiles set asaas_customer_id = $2, asaas_customer_owned = $3, asaas_customer_stale = false
		  where id = $1 and asaas_customer_id is null returning asaas_customer_id`,
		[payerProfileId, asaasCustomerId, owned],
	);
	if (claimed.rows[0]) return claimed.rows[0].asaas_customer_id;

	const { rows } = await client.query<{ asaas_customer_id: string | null }>(
		"select asaas_customer_id from payer_profiles where id = $1",
		[payerProfileId],
	);
	const winner = rows[0]?.asaas_customer_id;
	if (!winner) throw new Error("claimAsaasCustomer: linha do pagador não encontrada");
	return winner;
}

// Cliente Asaas atualizado com os dados atuais: a linha deixa de estar desatualizada.
export async function markPayerSynced(client: PoolClient, payerProfileId: string): Promise<void> {
	await client.query("update payer_profiles set asaas_customer_stale = false where id = $1", [payerProfileId]);
}
