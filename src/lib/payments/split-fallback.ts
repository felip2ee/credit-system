// Split recusado na criação (walletId desconhecido, split desligado na conta): uma nova tentativa sem split, para o
// cliente poder pagar. As linhas asaas viram `refused` só quando a cobrança sem split existe ou pode existir.
import { AsaasOutcomeUnknownError, AsaasSplitRejectedError, type AsaasSplitItem } from "@/lib/asaas";

export async function createWithSplitFallback<T>(
	chargeId: string,
	split: AsaasSplitItem[],
	create: (split: AsaasSplitItem[]) => Promise<T>,
	markRefused: () => Promise<unknown>,
): Promise<T> {
	try {
		return await create(split);
	} catch (error) {
		// A recusa é definitiva (nenhuma cobrança nasceu): repetir não duplica.
		if (!(error instanceof AsaasSplitRejectedError) || split.length === 0) throw error;
		console.error("[split] Asaas recusou o split: nova tentativa sem split", { chargeId });
	}
	// A falha ao marcar não desfaz a cobrança já criada: só vai ao log, para a conciliação.
	const mark = () =>
		markRefused().catch((error: unknown) => {
			console.error("[split] LINHAS não marcadas como recusadas", {
				chargeId,
				name: error instanceof Error ? error.name : typeof error,
				code: error instanceof Error && "code" in error ? error.code : undefined,
			});
		});
	let charge: T;
	try {
		charge = await create([]);
	} catch (error) {
		if (error instanceof AsaasOutcomeUnknownError) await mark();
		throw error;
	}
	await mark();
	return charge;
}
