// Afiliados (026). Só leitura dos dados do próprio afiliado: código e carteira por RLS, listas com nome dos indicados
// pelas funções affiliate_my_* (o cliente não lê o perfil de outro cliente nem charge_splits). Nunca documento, walletId
// nem resultado de consulta.
import type { PoolClient } from "pg";

import type {
	AffiliateCommissionRow,
	AffiliateReferralRow,
	AffiliateWallet,
	ChargeSplitStatus,
	CommissionStatus,
} from "./types";

type SummaryRow = { code: string; pending: string; available: string };
type ReferralDbRow = { name: string; created_at: Date; recharged: string };
type CommissionDbRow = {
	created_at: Date;
	referred_name: string;
	product_name: string | null;
	order_value: string | null;
	amount: string;
	status: CommissionStatus;
	release_at: Date;
	recharge_value: string | null;
};
type AsaasDbRow = { created_at: Date; referred_name: string; base_value: string; amount: string; status: ChargeSplitStatus };

// Comissão da entrada (069) não tem pedido: o valor da recarga é affiliate_commissions.margin, lido pela RLS do próprio
// afiliado. A chave do lançamento diz que a comissão veio de recarga.
const CASH_IN_COMMISSIONS = `affiliate_commissions c
		   join affiliate_ledger_entries e
		     on e.profile_id = c.affiliate_profile_id and e.idempotency_key = 'cashin:commission:' || c.order_ref::text`;

export async function getMyAffiliateSummary(client: PoolClient): Promise<{
	code: string;
	wallet: AffiliateWallet;
	referrals: AffiliateReferralRow[];
	commissions: AffiliateCommissionRow[];
} | null> {
	const { rows } = await client.query<SummaryRow>(
		`select c.code, w.pending, w.available
		   from affiliate_codes c
		   join affiliate_wallets w on w.profile_id = c.profile_id
		  where c.profile_id = app_user_id()`,
	);
	const summary = rows[0];
	if (!summary) return null;

	// shortcut: as funções affiliate_my_* não devolvem id, então a linha casa por created_at (microssegundos); quando uma
	// migration expuser o id do indicado e a cobrança, casar por eles.
	const referrals = await client.query<ReferralDbRow>(
		`with asaas as materialized (select * from affiliate_my_asaas_commissions())
		 select f.name, f.created_at,
		        ((select coalesce(sum(c.margin), 0)
		           from ${CASH_IN_COMMISSIONS}
		           join affiliate_referrals a
		             on a.affiliate_profile_id = c.affiliate_profile_id and a.referred_profile_id = c.referred_profile_id
		          where a.affiliate_profile_id = app_user_id() and a.created_at = f.created_at
		            and c.status <> 'reversed')
		         + (select coalesce(sum(s.base_value), 0) from asaas s
		             where s.referred_at = f.created_at and s.status in ('pending', 'done')))::numeric(15,2) as recharged
		   from affiliate_my_referrals() f
		  order by f.created_at desc`,
	);
	const commissions = await client.query<CommissionDbRow>(
		`select f.created_at, f.referred_name, f.product_name, f.order_value, f.amount, f.status, f.release_at,
		        (select c.margin
		           from ${CASH_IN_COMMISSIONS}
		          where c.affiliate_profile_id = app_user_id() and c.created_at = f.created_at and c.amount = f.amount
		          limit 1) as recharge_value
		   from affiliate_my_commissions() f
		  order by f.created_at desc`,
	);
	// Modo conta Asaas (080): paga pelo split, fora da carteira. Cada cobrança tem uma linha só, em um dos dois modos.
	const asaas = await client.query<AsaasDbRow>(
		`select created_at, referred_name, base_value, amount, status
		   from affiliate_my_asaas_commissions()
		  order by created_at desc
		  limit 200`,
	);
	return {
		code: summary.code,
		wallet: { pending: summary.pending, available: summary.available },
		referrals: referrals.rows.map((r) => ({
			name: r.name,
			createdAt: r.created_at.toISOString(),
			recharged: r.recharged,
		})),
		commissions: [
			...commissions.rows.map((r) => ({
				paidBy: "wallet" as const,
				createdAt: r.created_at.toISOString(),
				referredName: r.referred_name,
				productName: r.product_name ?? "",
				baseValue: r.recharge_value ?? r.order_value,
				fromRecharge: r.recharge_value !== null,
				amount: r.amount,
				status: r.status,
				releaseAt: r.release_at.toISOString(),
			})),
			...asaas.rows.map((r) => ({
				paidBy: "asaas" as const,
				createdAt: r.created_at.toISOString(),
				referredName: r.referred_name,
				productName: "",
				baseValue: r.base_value,
				fromRecharge: true,
				amount: r.amount,
				status: r.status,
			})),
		].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
	};
}
