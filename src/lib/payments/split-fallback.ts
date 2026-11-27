// Split recusado na criação (walletId desconhecido, split desligado na conta): primeiro uma tentativa sem o item do
// afiliado (os outros continuam no split); se também for recusada, ou se não houver o que separar, uma sem split, para o
// cliente poder pagar. As partes que saíram do split viram valor a pagar por fora (086) só quando a cobrança nova existe
// ou pode existir.
import { AsaasOutcomeUnknownError, AsaasSplitRejectedError, type AsaasSplitItem } from "@/lib/asaas";
import type { SplitPlan, SplitRefusal } from "@/lib/commission/split-plan";

export async function createWithSplitFallback<T>(
	chargeId: string,
	{ asaasSplit, asaasSplitWithoutAffiliate }: Pick<SplitPlan, "asaasSplit" | "asaasSplitWithoutAffiliate">,
	create: (split: AsaasSplitItem[]) => Promise<T>,
	markRefused: (refusal: SplitRefusal) => Promise<unknown>,
): Promise<T> {
	// A recusa é definitiva (nenhuma cobrança nasceu): repetir não duplica. Qualquer outro erro sobe.
	const assertRejected = (error: unknown, next: string) => {
		if (!(error instanceof AsaasSplitRejectedError)) throw error;
		console.error(`[split] Asaas recusou o split: nova tentativa ${next}`, { chargeId });
	};
	// A falha ao marcar não desfaz a cobrança já criada: só vai ao log, para a conciliação.
	const mark = (refusal: SplitRefusal) =>
		markRefused(refusal).catch((error: unknown) => {
			console.error("[split] LINHAS não marcadas como recusadas", {
				chargeId,
				...refusal,
				name: error instanceof Error ? error.name : typeof error,
				code: error instanceof Error && "code" in error ? error.code : undefined,
			});
		});
	// Resultado desconhecido: a cobrança pode existir sem esses itens, então marca; mas não prova de quem foi a culpa.
	const retry = async (split: AsaasSplitItem[], refusal: SplitRefusal) => {
		let charge: T;
		try {
			charge = await create(split);
		} catch (error) {
			if (error instanceof AsaasOutcomeUnknownError) await mark({ ...refusal, switchAffiliate: false });
			throw error;
		}
		await mark(refusal);
		return charge;
	};

	try {
		return await create(asaasSplit);
	} catch (error) {
		if (asaasSplit.length === 0) throw error;
		const others = asaasSplitWithoutAffiliate.length;
		// Sem outro item, o sucesso sem split não prova que a causa é o walletId do afiliado (o split pode estar desligado).
		if (others > 0 && others < asaasSplit.length) {
			assertRejected(error, "sem o afiliado");
			try {
				return await retry(asaasSplitWithoutAffiliate, { affiliateOnly: true, switchAffiliate: true });
			} catch (retryError) {
				assertRejected(retryError, "sem split");
			}
		} else {
			assertRejected(error, "sem split");
		}
	}
	return retry([], { affiliateOnly: false, switchAffiliate: false });
}
