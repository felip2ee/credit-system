// % de afiliados do Bureau (055): uma só por Bureau (bureau_affiliate_settings.default_pct). A leitura é da equipe do
// Bureau e do superadmin; a escrita só do superadmin sem suporte (RLS). affiliate_rates é legado só de leitura.
// Toda escrita grava auditoria na mesma transação. Nenhum PoolClient sai daqui.
import { writeAuditEvent } from "@/lib/audit/write";
import { config } from "@/lib/config";
import { lockCommissionSplit, assertSplitWithin100, SplitOver100Error } from "@/lib/commission/queries";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type BureauAffiliate = {
	profileId: string;
	name: string;
	code: string;
	referrals: number;
	totalCommission: string;
};

type AffiliateDbRow = {
	profile_id: string;
	name: string;
	code: string;
	referrals: number;
	total_commission: string;
};

export function affiliateLink(slug: string, code: string): string {
	return `${config.betterAuthUrl}/b/${slug}/cadastro?ref=${code}`;
}

export async function listBureauAffiliates(identity: DbIdentity): Promise<BureauAffiliate[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<AffiliateDbRow>(
			`select c.profile_id, p.full_name as name, c.code,
			        (select count(*)::int from affiliate_referrals r where r.affiliate_profile_id = c.profile_id) as referrals,
			        (select coalesce(sum(m.amount - m.reversed_amount), 0)::numeric(15,2)
			           from affiliate_commissions m where m.affiliate_profile_id = c.profile_id) as total_commission
			   from affiliate_codes c
			   join profiles p on p.id = c.profile_id
			  where c.bureau_id = app_bureau_id()
			  order by p.full_name, c.profile_id`,
		);
		return rows.map((r) => ({
			profileId: r.profile_id,
			name: r.name,
			code: r.code,
			referrals: r.referrals,
			totalCommission: r.total_commission,
		}));
	});
}

// Sem linha em bureau_affiliate_settings, a % de afiliados é 0 (default da coluna). Sem bureauId, lê o Bureau da sessão.
export async function getBureauDefaultPct(identity: DbIdentity, bureauId?: string): Promise<string> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ default_pct: string }>(
			"select default_pct from bureau_affiliate_settings where bureau_id = coalesce($1::uuid, app_bureau_id())",
			[bureauId ?? null],
		);
		return rows[0]?.default_pct ?? "0.00";
	});
}

export type SetBureauDefaultPctResult = { ok: true } | { ok: false; reason: "not_found" | "split_over_100" };

// Só o superadmin sem suporte escreve (RLS). Trava bureau_pct + affiliate_pct <= 100 na mesma transação: a % efetiva do
// Bureau é o override mais recente (nulo = global) ou a global; sem nenhuma, não há o que somar.
export async function setBureauDefaultPct(
	identity: DbIdentity,
	bureauId: string,
	pct: string,
): Promise<SetBureauDefaultPctResult> {
	try {
		return await withUserTransaction(identity, async (client) => {
			await lockCommissionSplit(client);
			const known = await client.query("select 1 from bureaus where id = $1", [bureauId]);
			if (known.rowCount === 0) return { ok: false, reason: "not_found" } as const;

			const before = await client.query<{ default_pct: string }>(
				"select default_pct from bureau_affiliate_settings where bureau_id = $1",
				[bureauId],
			);
			await client.query(
				`insert into bureau_affiliate_settings (bureau_id, default_pct, updated_by, updated_at)
				 values ($1, $2::numeric, $3, now())
				 on conflict (bureau_id) do update
				   set default_pct = excluded.default_pct, updated_by = excluded.updated_by, updated_at = now()`,
				[bureauId, pct, identity.userId],
			);
			await assertSplitWithin100(client, bureauId);

			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "affiliate.rate",
				targetTable: "bureau_affiliate_settings",
				targetId: bureauId,
				bureauId,
				metadata: { scope: "default", bureau_id: bureauId, from: before.rows[0]?.default_pct ?? "0.00", to: pct },
			});
			return { ok: true } as const;
		});
	} catch (error) {
		if (error instanceof SplitOver100Error) return { ok: false, reason: "split_over_100" };
		throw error;
	}
}
