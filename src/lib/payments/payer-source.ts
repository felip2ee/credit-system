// Dados do pagador do checkout: dono da conta (payer_profiles, cifrado) ou "outros" (nada fica salvo).
// Nada aqui grava em log ou erro documento, CEP ou número completos.
import type { PoolClient } from "pg";

import type { PiiKeyring } from "@/lib/config";
import type { DbIdentity } from "@/lib/db/transaction";
import {
	getOwnerPayerView,
	loadOwnerPayerForCharge,
	saveOwnerPayer,
	type OwnerPayerForCharge,
	type PayerField,
	type ResolvedPayer,
} from "@/lib/payers/queries";
import { asaasPhone, missingPayerFields, requiredOtherPayerFields } from "@/lib/payers/resolve";
import type { CheckoutInput } from "@/lib/validators/checkout";
import type { BillingType, ChargeScope } from "@/lib/wallet/pix-charges";

// Falha esperada dentro da transação: desfaz a reserva e vira `{ error }`.
export class BlockedError extends Error {}

const MISSING_FIELDS = "Preencha os dados de pagamento que faltam.";
const INVALID_FIELDS = "Confira os dados do pagador.";
const CARD_PHONE = "Informe um celular brasileiro com DDD.";

// Fecha o payer em um ResolvedPayer. Campo que a forma de pagamento exige e falta = BlockedError.
function completePayer(partial: Partial<ResolvedPayer>, method: BillingType, nfseOn: boolean): ResolvedPayer {
	const card = method === "CREDIT_CARD";
	const needsAddress = card || nfseOn;
	const { name, cpfCnpj, email } = partial;
	if (!name || !cpfCnpj || !email) throw new BlockedError(MISSING_FIELDS);
	if (needsAddress && (!partial.postalCode || !partial.addressNumber)) throw new BlockedError(MISSING_FIELDS);
	if (card) {
		if (!partial.phone) throw new BlockedError(MISSING_FIELDS);
		if (!asaasPhone(partial.phone)) throw new BlockedError(CARD_PHONE);
	}
	return {
		name,
		cpfCnpj,
		email,
		phone: partial.phone ?? null,
		postalCode: partial.postalCode ?? null,
		addressNumber: partial.addressNumber ?? null,
	};
}

export type PayerSource = {
	payer: ResolvedPayer;
	// Dono: a linha de payer_profiles e o estado do cliente Asaas. Outros: nada fica salvo.
	owner: OwnerPayerForCharge | null;
};

// "Outros": a pessoa digita tudo; nada vai para payer_profiles (D9).
export function otherPayer(input: CheckoutInput, nfseOn: boolean): PayerSource {
	const given = input.payer ?? {};
	const keys: Partial<Record<PayerField, string>> = given;
	if (requiredOtherPayerFields().some((field) => keys[field] === undefined)) throw new BlockedError(MISSING_FIELDS);
	const payer = completePayer(
		{
			name: given.name,
			cpfCnpj: given.document,
			email: given.email,
			phone: given.phone,
			postalCode: given.postalCode,
			addressNumber: given.addressNumber,
		},
		input.method,
		nfseOn,
	);
	return { payer, owner: null };
}

// Dono: os campos que a matriz pede e faltam vêm do formulário. "Alterar" também vem dele. Sem linha em
// payer_profiles, os dados do Titular (D8) são copiados cifrados na primeira cobrança.
export async function ownerPayer(
	client: PoolClient,
	session: DbIdentity,
	scope: ChargeScope,
	input: CheckoutInput,
	keyring: PiiKeyring,
	nfseOn: boolean,
): Promise<PayerSource> {
	const given = input.payer ?? {};
	const view = await getOwnerPayerView(client, session, scope);
	const keys: Partial<Record<PayerField, string>> = given;
	if (missingPayerFields(view, input.method, nfseOn).some((field) => keys[field] === undefined)) {
		throw new BlockedError(MISSING_FIELDS);
	}

	let loaded = await loadOwnerPayerForCharge(client, session, scope, keyring);
	// E-mail do dono é o da conta: a matriz não o pede.
	const { email: _ignored, ...ownerGiven } = given;
	const known =
		loaded.payerProfileId === null
			? {
					document: loaded.payer.cpfCnpj,
					postalCode: loaded.payer.postalCode,
					addressNumber: loaded.payer.addressNumber,
				}
			: {};
	const patch = Object.fromEntries(
		Object.entries({ ...known, ...ownerGiven }).filter(([, value]) => value !== undefined),
	) as Partial<Record<PayerField, string>>;
	if (Object.keys(patch).length > 0) {
		const saved = await saveOwnerPayer(client, session, scope, patch, keyring);
		if (!saved.ok) throw new BlockedError(INVALID_FIELDS);
		loaded = await loadOwnerPayerForCharge(client, session, scope, keyring);
	}
	if (!loaded.payerProfileId) throw new BlockedError(MISSING_FIELDS);
	return { payer: completePayer(loaded.payer, input.method, nfseOn), owner: loaded };
}

