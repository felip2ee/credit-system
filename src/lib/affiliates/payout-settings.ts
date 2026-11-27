// Como o afiliado de link recebe a comissão: conta Asaas (split na entrada) ou chave Pix (saldo + saque). O afiliado muda o
// próprio modo; o bureau_admin do bureau dele e o superadmin fora de suporte mudam em nome dele. A RLS (066) decide quem
// escreve; aqui só a regra de negócio e a auditoria na mesma transação. walletId só mascarado fora do banco.
// Trocar de modo vale só para cobranças criadas depois: o plano de split de cada cobrança guarda o modo do momento.
import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { setPayoutMethodSchema } from "@/lib/validators/affiliate-payout";

import type { PayoutMethod } from "./types";

export type PayoutSettings = { method: PayoutMethod; walletIdMasked: string | null };

type SettingsRow = { bureau_id: string; payout_method: PayoutMethod; asaas_wallet_id: string | null };

// 8 primeiros e 4 últimos caracteres: dá para o usuário conferir, não para reconstruir o ID.
export function maskWalletId(walletId: string): string {
	return `${walletId.slice(0, 8)}…${walletId.slice(-4)}`;
}

const NOT_ALLOWED = "Você não tem permissão para alterar este pagamento.";

export async function getPayoutSettings(identity: DbIdentity, profileId: string): Promise<PayoutSettings | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<SettingsRow>(
			"select bureau_id, payout_method, asaas_wallet_id from affiliate_wallets where profile_id = $1",
			[profileId],
		);
		const row = rows[0];
		if (!row) return null;
		return { method: row.payout_method, walletIdMasked: row.asaas_wallet_id ? maskWalletId(row.asaas_wallet_id) : null };
	});
}

export async function setPayoutMethod(
	identity: DbIdentity,
	input: { owner: { profileId: string }; method: PayoutMethod; asaasWalletId?: string },
): Promise<{ error: string | null }> {
	const parsed = setPayoutMethodSchema.safeParse({ method: input.method, asaasWalletId: input.asaasWalletId });
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const { method, asaasWalletId } = parsed.data;

	const { role, userId, supportSessionId } = identity;
	const mayWrite =
		(role === "client" && input.owner.profileId === userId) ||
		role === "bureau_admin" ||
		(role === "superadmin" && !supportSessionId);
	if (!mayWrite) return { error: NOT_ALLOWED };

	return withUserTransaction(identity, async (client) => {
		// A RLS já esconde o afiliado de outro bureau: sem linha, "não encontrado" (sem revelar que existe).
		const before = await client.query<SettingsRow>(
			"select bureau_id, payout_method, asaas_wallet_id from affiliate_wallets where profile_id = $1 for update",
			[input.owner.profileId],
		);
		const prev = before.rows[0];
		if (!prev) return { error: "Afiliado não encontrado." };

		if (method === "asaas" && !(asaasWalletId ?? prev.asaas_wallet_id)) return { error: "Informe o walletId da sua conta Asaas." };

		// Modo Pix mantém o walletId já salvo (some do split, mas a pessoa não precisa digitar de novo ao voltar).
		const updated = await client.query(
			"update affiliate_wallets set payout_method = $2, asaas_wallet_id = coalesce($3, asaas_wallet_id) where profile_id = $1",
			[input.owner.profileId, method, asaasWalletId ?? null],
		);
		if (updated.rowCount !== 1) return { error: NOT_ALLOWED };

		const nextWallet = asaasWalletId ?? prev.asaas_wallet_id;
		await writeAuditEvent(client, {
			actorId: userId,
			action: "affiliate.payout_method",
			targetTable: "affiliate_wallets",
			targetId: input.owner.profileId,
			// Sem bureauId: a RLS da auditoria só aceita evento do superadmin com Bureau alvo para ações listadas na política.
			metadata: {
				bureau_id: prev.bureau_id,
				from: prev.payout_method,
				to: method,
				on_behalf: userId !== input.owner.profileId,
				wallet_masked: nextWallet ? maskWalletId(nextWallet) : null,
			},
		});
		return { error: null };
	});
}
