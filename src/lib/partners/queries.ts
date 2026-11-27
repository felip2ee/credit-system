// Sócios da plataforma (platform_partners) e walletId do bureau (bureau_asaas_wallets). Só o superadmin fora de suporte
// escreve (RLS); a equipe do bureau lê o walletId do próprio bureau. Toda escrita grava auditoria na mesma transação,
// com o walletId mascarado. Evento da plataforma (bureau_id nulo): o ramo do superadmin em audit_logs_insert só aceita
// bureau alvo para ações listadas na política; o bureau vai em target_id e na metadata. Nenhum PoolClient sai daqui.
import { maskWalletId } from "@/lib/asaas/wallet-mask";
import { writeAuditEvent } from "@/lib/audit/write";
import { assertSplitWithin100, lockCommissionSplit, SplitOver100Error } from "@/lib/commission/queries";
import { platformWriteIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { BureauWalletInput, PartnerInput } from "@/lib/validators/partners";

const FOREIGN_KEY_VIOLATION = "23503";

export { maskWalletId };

export type Partner = { id: string; name: string; asaasWalletId: string; pct: string; active: boolean };
export type PartnerWriteResult = { error: string | null; id?: string };

export async function listPartners(identity: DbIdentity): Promise<Partner[]> {
	const { rows } = await withUserTransaction(identity, (client) =>
		client.query<{ id: string; name: string; asaas_wallet_id: string; pct: string; active: boolean }>(
			"select id, name, asaas_wallet_id, pct, active from platform_partners order by created_at, id",
		),
	);
	return rows.map((r) => ({ id: r.id, name: r.name, asaasWalletId: r.asaas_wallet_id, pct: r.pct, active: r.active }));
}

// Cria (sem id) ou edita (com id). Soma sócios + bureau + indicador + afiliado <= 100 sob o lock da comissão.
export async function upsertPartner(identity: DbIdentity, input: PartnerInput): Promise<PartnerWriteResult> {
	try {
		return await withUserTransaction(platformWriteIdentity(identity), async (client) => {
			await lockCommissionSplit(client);
			const previous = input.id
				? await client.query<{ asaas_wallet_id: string }>("select asaas_wallet_id from platform_partners where id = $1", [input.id])
				: null;
			const before = previous?.rows[0]?.asaas_wallet_id;
			const { rows } = input.id
				? await client.query<{ id: string }>(
						`update platform_partners set name = $2, asaas_wallet_id = $3, pct = $4, active = $5
              where id = $1 returning id`,
						[input.id, input.name, input.asaasWalletId, input.pct, input.active],
					)
				: await client.query<{ id: string }>(
						`insert into platform_partners (name, asaas_wallet_id, pct, active)
             values ($1, $2, $3, $4) returning id`,
						[input.name, input.asaasWalletId, input.pct, input.active],
					);
			const id = rows[0]?.id;
			if (!id) return { error: "Sócio não encontrado." };
			await assertSplitWithin100(client, null);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "partner.upsert",
				targetTable: "platform_partners",
				targetId: id,
				metadata: {
					created: !input.id,
					name: input.name,
					wallet_before: before ? maskWalletId(before) : null,
					wallet: maskWalletId(input.asaasWalletId),
					pct: input.pct,
					active: input.active,
				},
			});
			return { error: null, id };
		});
	} catch (error) {
		if (error instanceof SplitOver100Error) {
			return { error: "A soma das porcentagens (sócios, bureau, indicador e afiliados) passa de 100%. Reduza uma delas." };
		}
		throw error;
	}
}

export async function getBureauWalletId(identity: DbIdentity, bureauId: string): Promise<string | null> {
	const { rows } = await withUserTransaction(identity, (client) =>
		client.query<{ asaas_wallet_id: string }>("select asaas_wallet_id from bureau_asaas_wallets where bureau_id = $1", [bureauId]),
	);
	return rows[0]?.asaas_wallet_id ?? null;
}

export async function setBureauWalletId(identity: DbIdentity, input: BureauWalletInput): Promise<{ error: string | null }> {
	const { bureauId, asaasWalletId } = input;
	try {
		await withUserTransaction(platformWriteIdentity(identity), async (client) => {
			const previous = await client.query<{ asaas_wallet_id: string }>(
				"select asaas_wallet_id from bureau_asaas_wallets where bureau_id = $1",
				[bureauId],
			);
			await client.query(
				`insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id, updated_by) values ($1, $2, $3)
         on conflict (bureau_id) do update
           set asaas_wallet_id = excluded.asaas_wallet_id, updated_by = excluded.updated_by, updated_at = now()`,
				[bureauId, asaasWalletId, identity.userId],
			);
			const before = previous.rows[0]?.asaas_wallet_id;
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "bureau_wallet.set",
				targetTable: "bureaus",
				targetId: bureauId,
				metadata: {
					bureau_id: bureauId,
					from: before ? maskWalletId(before) : null,
					to: maskWalletId(asaasWalletId),
				},
			});
		});
		return { error: null };
	} catch (error) {
		if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) return { error: "Bureau não encontrado." };
		throw error;
	}
}
