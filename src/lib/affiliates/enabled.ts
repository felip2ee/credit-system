// Interruptor do afiliado de link (080): desligado por padrão. Desligado, a seção /portal/afiliacao some, as ações de saque e
// de configurar pagamentos recusam e o split ignora o afiliado de link (073). O bureau_admin liga e desliga o próprio
// Bureau; o superadmin fora de suporte, qualquer Bureau (bureauId). Auditoria na mesma transação.
import { writeAuditEvent } from "@/lib/audit/write";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

const NOT_ALLOWED = "Você não tem permissão para alterar a seção de afiliado.";

// Bureau da sessão (o cliente não lê bureau_affiliate_settings: a função SQL devolve só o booleano). Sem linha = desligado.
export async function isAffiliateEnabled(identity: DbIdentity): Promise<boolean> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ enabled: boolean }>("select affiliate_enabled() as enabled");
		return rows[0]?.enabled === true;
	});
}

// Seção de afiliado aberta ao cliente: permissão de leitura e interruptor ligado.
export async function isAffiliateSectionOpen(identity: DbIdentity): Promise<boolean> {
	return hasPermission(identity, "affiliates:read") && (await isAffiliateEnabled(identity));
}

export async function setAffiliateEnabled(
	identity: DbIdentity,
	input: { enabled: boolean; bureauId?: string },
): Promise<{ error: string | null }> {
	if (!hasPermission(identity, "affiliate_settings:manage")) return { error: NOT_ALLOWED };
	// Superadmin escreve fora de suporte (RLS) e informa o Bureau; bureau_admin só o dele.
	const bureauId = identity.role === "superadmin" ? input.bureauId : identity.bureauId;
	if (!bureauId || (identity.role === "superadmin" && identity.supportSessionId)) return { error: NOT_ALLOWED };

	return withUserTransaction(identity, async (client) => {
		const known = await client.query("select 1 from bureaus where id = $1", [bureauId]);
		if (known.rowCount === 0) return { error: "Bureau não encontrado." };

		const before = await client.query<{ affiliate_enabled: boolean }>(
			"select affiliate_enabled from bureau_affiliate_settings where bureau_id = $1 for update",
			[bureauId],
		);
		await client.query(
			`insert into bureau_affiliate_settings (bureau_id, affiliate_enabled, updated_by, updated_at)
			 values ($1, $2, $3, now())
			 on conflict (bureau_id) do update
			   set affiliate_enabled = excluded.affiliate_enabled, updated_by = excluded.updated_by, updated_at = now()`,
			[bureauId, input.enabled, identity.userId],
		);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "affiliate.enabled",
			targetTable: "bureau_affiliate_settings",
			targetId: bureauId,
			metadata: { bureau_id: bureauId, from: before.rows[0]?.affiliate_enabled ?? false, to: input.enabled },
		});
		return { error: null };
	});
}
