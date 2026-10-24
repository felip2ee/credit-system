// % de comissão do Bureau (026): padrão do Bureau e % própria por afiliado. A leitura é da equipe, a escrita só do
// bureau_admin do próprio Bureau (RLS). Toda escrita grava auditoria na mesma transação. Nenhum PoolClient sai daqui.
import { writeAuditEvent } from "@/lib/audit/write";
import { config } from "@/lib/config";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type BureauAffiliate = {
	profileId: string;
	name: string;
	code: string;
	referrals: number;
	// null = usa o padrão do Bureau.
	pct: string | null;
	totalCommission: string;
};

type AffiliateDbRow = {
	profile_id: string;
	name: string;
	code: string;
	referrals: number;
	pct: string | null;
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
			        ar.pct,
			        (select coalesce(sum(m.amount - m.reversed_amount), 0)::numeric(15,2)
			           from affiliate_commissions m where m.affiliate_profile_id = c.profile_id) as total_commission
			   from affiliate_codes c
			   join profiles p on p.id = c.profile_id
			   left join affiliate_rates ar on ar.affiliate_profile_id = c.profile_id and ar.bureau_id = c.bureau_id
			  where c.bureau_id = app_bureau_id()
			  order by p.full_name, c.profile_id`,
		);
		return rows.map((r) => ({
			profileId: r.profile_id,
			name: r.name,
			code: r.code,
			referrals: r.referrals,
			pct: r.pct,
			totalCommission: r.total_commission,
		}));
	});
}

// Sem linha em bureau_affiliate_settings, o padrão do Bureau é 0 (default da coluna).
export async function getBureauDefaultPct(identity: DbIdentity): Promise<string> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ default_pct: string }>(
			"select default_pct from bureau_affiliate_settings where bureau_id = app_bureau_id()",
		);
		return rows[0]?.default_pct ?? "0.00";
	});
}

export async function setBureauDefaultPct(identity: DbIdentity, pct: string): Promise<void> {
	await withUserTransaction(identity, async (client) => {
		await client.query(
			`insert into bureau_affiliate_settings (bureau_id, default_pct, updated_by, updated_at)
			 values (app_bureau_id(), $1::numeric, $2, now())
			 on conflict (bureau_id) do update
			   set default_pct = excluded.default_pct, updated_by = excluded.updated_by, updated_at = now()`,
			[pct, identity.userId],
		);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "affiliate.rate",
			targetTable: "bureau_affiliate_settings",
			targetId: identity.bureauId,
			metadata: { scope: "default", pct },
		});
	});
}

// null remove a % própria: o afiliado volta a usar o padrão. Afiliado de outro Bureau não aparece sob RLS: not_found.
export async function setAffiliatePct(
	identity: DbIdentity,
	affiliateProfileId: string,
	pct: string | null,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	return withUserTransaction(identity, async (client) => {
		const known = await client.query("select 1 from affiliate_codes where profile_id = $1 and bureau_id = app_bureau_id()", [
			affiliateProfileId,
		]);
		if (known.rowCount === 0) return { ok: false, reason: "not_found" } as const;

		if (pct === null) {
			await client.query("delete from affiliate_rates where affiliate_profile_id = $1 and bureau_id = app_bureau_id()", [
				affiliateProfileId,
			]);
		} else {
			await client.query(
				`insert into affiliate_rates (bureau_id, affiliate_profile_id, pct, updated_by, updated_at)
				 values (app_bureau_id(), $1, $2::numeric, $3, now())
				 on conflict (bureau_id, affiliate_profile_id) do update
				   set pct = excluded.pct, updated_by = excluded.updated_by, updated_at = now()`,
				[affiliateProfileId, pct, identity.userId],
			);
		}
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "affiliate.rate",
			targetTable: "affiliate_rates",
			targetId: affiliateProfileId,
			metadata: { scope: "affiliate", pct },
		});
		return { ok: true } as const;
	});
}
