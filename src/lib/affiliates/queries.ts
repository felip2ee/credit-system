// Afiliados (026). Só leitura dos dados do próprio afiliado: código e carteira por RLS, listas com nome dos indicados
// pelas funções affiliate_my_* (o cliente não lê o perfil de outro cliente). Nunca documento nem resultado de consulta.
import type { PoolClient } from "pg";

import type { AffiliateCommissionRow, AffiliateReferralRow, AffiliateWallet, CommissionStatus } from "./types";

type SummaryRow = { code: string; pending: string; available: string };
type ReferralDbRow = { name: string; created_at: Date; total_spent: string };
type CommissionDbRow = {
	created_at: Date;
	referred_name: string;
	product_name: string | null;
	order_value: string | null;
	amount: string;
	status: CommissionStatus;
	release_at: Date;
};

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

	const referrals = await client.query<ReferralDbRow>(
		"select name, created_at, total_spent from affiliate_my_referrals()",
	);
	const commissions = await client.query<CommissionDbRow>(
		`select created_at, referred_name, product_name, order_value, amount, status, release_at
		   from affiliate_my_commissions()`,
	);
	return {
		code: summary.code,
		wallet: { pending: summary.pending, available: summary.available },
		referrals: referrals.rows.map((r) => ({
			name: r.name,
			createdAt: r.created_at.toISOString(),
			totalSpent: r.total_spent,
		})),
		commissions: commissions.rows.map((r) => ({
			createdAt: r.created_at.toISOString(),
			referredName: r.referred_name,
			productName: r.product_name ?? "",
			orderValue: r.order_value ?? "0.00",
			amount: r.amount,
			status: r.status,
			releaseAt: r.release_at.toISOString(),
		})),
	};
}
