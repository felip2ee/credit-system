// Métricas do app do admin do Bureau. Visita: contagem diária agregada, sem IP, sem cookie (gravada por visit-buffer.ts).
// Nenhum PoolClient sai deste módulo.
import { getRevenueSummary } from "@/lib/dashboard/queries";
import { canViewRevenue } from "@/lib/dashboard/access";
import { revenueRange, type RevenuePeriodKey } from "@/lib/dashboard/period";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

const RANKING_SIZE = 5;

export type BureauAdminMetrics = {
	visits: number;
	signups: number;
	sales: number;
	revenue: number | null;
	affiliates: number;
	ranking: { name: string; sales: number; commission: number }[];
};

// Tudo do Bureau do chamador (ctx.bureauId, mais a RLS). Cadastros = contas de cliente criadas no Bureau no período
// (todo cadastro de cliente nasce pela página do Bureau; affiliate_referrals só cobre os indicados).
// Vendas = pedidos capturados (order_settlements) no período, a mesma base do faturamento. A comissão do afiliado no
// ranking soma as comissões criadas no período: a do pedido antigo (captura) e a da entrada de dinheiro (072, order_ref =
// cobrança); um afiliado só com comissão da entrada (sem pedido capturado no período) também aparece.
export async function getBureauAdminMetrics(ctx: DbIdentity, period: RevenuePeriodKey): Promise<BureauAdminMetrics> {
	if (!ctx.bureauId) throw new Error("getBureauAdminMetrics requires a bureau context");
	const bureauId = ctx.bureauId;
	const range = revenueRange(period);

	const revenue = await getRevenueSummary(ctx, range, range.start);

	return withUserTransaction(ctx, async (client) => {
		// Dia de Brasília do período; bureau_page_views.day é uma data.
		const counts = await client.query<{ visits: number; signups: number; affiliates: number }>(
			`select
			   (select coalesce(sum(count), 0)::int from bureau_page_views
			     where bureau_id = $1
			       and day >= ($2::timestamptz at time zone 'America/Sao_Paulo')::date
			       and day < ($3::timestamptz at time zone 'America/Sao_Paulo')::date) as visits,
			   (select count(*)::int from profiles
			     where bureau_id = $1 and role = 'client' and created_at >= $2 and created_at < $3) as signups,
			   (select count(*)::int from affiliate_codes where bureau_id = $1) as affiliates`,
			[bureauId, range.start, range.end],
		);
		const ranking = await client.query<{ name: string; sales: number; commission: number }>(
			`select p.full_name as name, count(s.id)::int as sales,
			        (select coalesce(sum(m.amount - m.reversed_amount), 0)::float8 from affiliate_commissions m
			          where m.bureau_id = $1 and m.affiliate_profile_id = r.affiliate_profile_id
			            and m.created_at >= $2 and m.created_at < $3) as commission
			   from affiliate_referrals r
			   left join order_settlements s on s.client_profile_id = r.referred_profile_id and s.bureau_id = r.bureau_id
			        and s.status = 'captured' and s.closed_at >= $2 and s.closed_at < $3
			   join profiles p on p.id = r.affiliate_profile_id
			  where r.bureau_id = $1
			  group by r.affiliate_profile_id, p.full_name
			 having count(s.id) > 0 or exists (
			          select 1 from affiliate_commissions m
			           where m.bureau_id = $1 and m.affiliate_profile_id = r.affiliate_profile_id
			             and m.created_at >= $2 and m.created_at < $3)
			  order by sales desc, commission desc, p.full_name
			  limit $4`,
			[bureauId, range.start, range.end, RANKING_SIZE],
		);
		return {
			visits: counts.rows[0].visits,
			signups: counts.rows[0].signups,
			sales: revenue.period.orders,
			revenue: canViewRevenue(ctx) ? revenue.period.amount : null,
			affiliates: counts.rows[0].affiliates,
			ranking: ranking.rows,
		};
	});
}
