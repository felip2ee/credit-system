// Regras puras do pagador e o ciclo do cliente Asaas (spec "Ciclo do cliente Asaas", passos 1 a 5).
// Nenhuma chamada de banco aqui e nenhuma transação aberta: o banco entra por `claim` e `markSynced`.
// Nada neste arquivo grava documento, CEP ou número em log ou em erro.
import { AsaasHttpError } from "@/lib/asaas/client";
import type { AsaasClient, AsaasCustomerInput } from "@/lib/asaas/types";

import type { OwnerPayerView, PayerField, ResolvedPayer } from "./queries";

const ALL_FIELDS: PayerField[] = ["name", "document", "email", "phone", "postalCode", "addressNumber"];

// Matriz de campos do spec, colunas "dono". Nome e documento: obrigatórios se faltam no banco. E-mail: o da conta.
// Telefone: só no cartão. CEP e número: sempre no cartão; no Pix só com a NFS-e ligada (D13).
export function missingPayerFields(
	view: OwnerPayerView,
	method: "PIX" | "CREDIT_CARD",
	nfseOn: boolean,
): PayerField[] {
	const card = method === "CREDIT_CARD";
	const needsAddress = card || nfseOn;
	const missing: PayerField[] = [];
	if (view.name === null) missing.push("name");
	if (view.documentMasked === null) missing.push("document");
	if (card && view.phoneMasked === null) missing.push("phone");
	if (needsAddress && view.postalCodeMasked === null) missing.push("postalCode");
	if (needsAddress && !view.hasAddressNumber) missing.push("addressNumber");
	return missing;
}

// Pagador "outros": a pessoa digita tudo, sempre.
export function requiredOtherPayerFields(): PayerField[] {
	return [...ALL_FIELDS];
}

// E.164 brasileiro (+55DDDNUMERO) para o formato do Asaas (DDDNUMERO). Outro país: sem telefone.
export function asaasPhone(e164: string | null): string | undefined {
	return e164 && /^\+55\d{10,11}$/.test(e164) ? e164.slice(3) : undefined;
}

function toCustomerInput(payer: ResolvedPayer): AsaasCustomerInput {
	const mobilePhone = asaasPhone(payer.phone);
	return {
		name: payer.name,
		cpfCnpj: payer.cpfCnpj,
		email: payer.email,
		...(mobilePhone ? { mobilePhone } : {}),
		...(payer.postalCode ? { postalCode: payer.postalCode } : {}),
		...(payer.addressNumber ? { addressNumber: payer.addressNumber } : {}),
	};
}

export type ResolveAsaasCustomerDeps = {
	asaas: AsaasClient;
	// Grava o cliente Asaas do dono se a linha ainda não tem um; devolve o id vencedor.
	claim: (asaasCustomerId: string, owned: boolean) => Promise<string>;
	// Marca o cliente Asaas como sincronizado depois de um updateCustomer.
	markSynced: () => Promise<void>;
	// Apaga da linha do dono o id de um cliente que não existe mais no Asaas.
	forget: (deadAsaasCustomerId: string) => Promise<void>;
};

export type ResolveAsaasCustomerInput = {
	payer: ResolvedPayer;
	kind: "owner" | "other";
	current: { asaasCustomerId: string | null; owned: boolean; stale: boolean } | null;
	payerProfileId: string | null;
	// Cobrança reservada: a referência do cliente de um pagador "outros".
	chargeId: string;
};

// HTTP 400 ou 404 do Asaas: pode ser cliente apagado ou dado inválido. Quem chama confere com customerExists.
export const isDefiniteAsaasRejection = (error: unknown): boolean =>
	error instanceof AsaasHttpError && (error.status === 400 || error.status === 404);

// Devolve o id do cliente Asaas do pagador. Nunca acha cliente por CPF/CNPJ: um documento digitado por outra pessoa
// levaria à cobrança e à NFS-e (nome, endereço, e-mail) de um terceiro. "Outros" sempre ganha um cliente novo, com a
// cobrança como referência (a nova tentativa o acha por ela). O dono converge pela referência = id da linha do pagador.
// Só atualiza cliente que nós criamos (D10). AsaasOutcomeUnknownError na criação sobe: a próxima tentativa acha o
// cliente pela referência (create não é idempotente). Cliente guardado que sumiu do Asaas é esquecido e refeito uma vez.
export async function resolveAsaasCustomer(
	deps: ResolveAsaasCustomerDeps,
	input: ResolveAsaasCustomerInput,
): Promise<string> {
	const { asaas, claim, markSynced, forget } = deps;
	const { payer, kind, current, payerProfileId, chargeId } = input;

	if (kind === "other") {
		const existing = await asaas.findCustomerByExternalReference(chargeId);
		if (existing) return existing;
		return (await asaas.createCustomer({ ...toCustomerInput(payer), externalReference: chargeId })).asaasCustomerId;
	}

	const stored = current?.asaasCustomerId;
	if (stored) {
		if (!(current.stale && current.owned)) return stored;
		try {
			await asaas.updateCustomer(stored, toCustomerInput(payer));
			await markSynced();
			return stored;
		} catch (error) {
			// 404/400 com o cliente ainda no Asaas é dado inválido: não é motivo para trocar de cliente.
			if (!isDefiniteAsaasRejection(error) || (await asaas.customerExists(stored))) throw error;
			await forget(stored);
		}
	}

	// Dono sem linha ainda (payerProfileId nulo): nada para gravar nem referência para enviar.
	if (!payerProfileId) return (await asaas.createCustomer(toCustomerInput(payer))).asaasCustomerId;

	const found = await asaas.findCustomerByExternalReference(payerProfileId);
	const asaasCustomerId =
		found ?? (await asaas.createCustomer({ ...toCustomerInput(payer), externalReference: payerProfileId })).asaasCustomerId;
	// O cliente tem a referência da nossa linha: nós o criamos (owned), mesmo quando achado numa nova tentativa.
	const winner = await claim(asaasCustomerId, true);
	if (winner !== asaasCustomerId && !found) {
		// Outra requisição ganhou a corrida: o cliente criado a mais fica órfão no Asaas (sem efeito no saldo).
		console.warn(`[payers] cliente Asaas criado a mais ficou órfão: ${asaasCustomerId}`);
	}
	return winner;
}
