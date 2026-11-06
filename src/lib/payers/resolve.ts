// Regras puras do pagador e o ciclo do cliente Asaas (spec "Ciclo do cliente Asaas", passos 1 a 5).
// Nenhuma chamada de banco aqui e nenhuma transação aberta: o banco entra por `claim` e `markSynced`.
// Nada neste arquivo grava documento, CEP ou número em log ou em erro.
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
};

export type ResolveAsaasCustomerInput = {
	payer: ResolvedPayer;
	kind: "owner" | "other";
	current: { asaasCustomerId: string | null; owned: boolean; stale: boolean } | null;
	payerProfileId: string | null;
};

// Devolve o id do cliente Asaas do pagador. Só atualiza cliente que nós criamos para o dono (D10): um CPF digitado por
// outra pessoa nunca troca e-mail ou endereço de um cliente alheio. AsaasOutcomeUnknownError na criação sobe: a
// próxima tentativa acha o cliente pela busca (create não é idempotente).
export async function resolveAsaasCustomer(
	deps: ResolveAsaasCustomerDeps,
	input: ResolveAsaasCustomerInput,
): Promise<string> {
	const { asaas, claim, markSynced } = deps;
	const { payer, kind, current, payerProfileId } = input;

	if (kind === "owner" && current?.asaasCustomerId) {
		if (current.stale && current.owned) {
			await asaas.updateCustomer(current.asaasCustomerId, toCustomerInput(payer));
			await markSynced();
		}
		return current.asaasCustomerId;
	}

	const found = await asaas.findCustomerByCpfCnpj(payer.cpfCnpj);
	if (kind === "other") {
		if (found) return found;
		return (await asaas.createCustomer(toCustomerInput(payer))).asaasCustomerId;
	}

	// Dono sem linha ainda (payerProfileId nulo): nada para gravar nem referência para enviar.
	const adopted = found !== null;
	const asaasCustomerId =
		found ??
		(
			await asaas.createCustomer({
				...toCustomerInput(payer),
				...(payerProfileId ? { externalReference: payerProfileId } : {}),
			})
		).asaasCustomerId;
	if (!payerProfileId) return asaasCustomerId;

	const winner = await claim(asaasCustomerId, !adopted);
	if (winner !== asaasCustomerId && !adopted) {
		// Outra requisição ganhou a corrida: o cliente criado a mais fica órfão no Asaas (sem efeito no saldo).
		console.warn(`[payers] cliente Asaas criado a mais ficou órfão: ${asaasCustomerId}`);
	}
	return winner;
}
