// Painel de repasses (charge_splits) e prejuízo por cliente (estorno e chargeback). Só leitura, sob RLS: o bureau_admin vê
// o próprio Bureau (sem as linhas dos sócios); o superadmin fora de suporte vê todos. Nenhum PoolClient sai daqui.
// Estorno x chargeback (decisão da task 7): pix_charges.status vira 'refunded' nos dois casos. O tipo está em
// asaas_webhook_events (event_type, só colunas sem payload): a cobrança é chargeback se um PAYMENT_CHARGEBACK_REQUESTED
// terminou em result = 'refunded'; é estorno se algum evento terminou em 'refunded' e não foi chargeback. Estorno antes do
// pagamento fica 'ignored' (nunca houve dinheiro) e não entra. O período filtra por pix_charges.created_at (o pagamento
// não grava data própria).
// shortcut: cobrança em cartão parcelado tem um id de pagamento por parcela; o evento de chargeback só casa a parcela que
// o Asaas citou. Trocar por asaas_installment_id se o chargeback de cartão ficar relevante.
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

import { maskWalletId } from "./payout-settings";
import type { BeneficiaryKind, ChargeSplitStatus } from "./types";

const MAX_SPLIT_ROWS = 500;
const DEFAULT_RANGE_DAYS = 30;
const SP_OFFSET = "-03:00";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReportRange = { from: string; to: string };

export type SplitReportRow = {
	id: string;
	pixChargeId: string;
	bureauId: string;
	bureauName: string;
	createdAt: Date;
	beneficiaryKind: BeneficiaryKind;
	// null quando o RLS esconde o nome (ex.: Bureau indicador visto pelo Bureau indicado).
	beneficiaryName: string | null;
	payoutMethod: "asaas" | "pix" | "accrual";
	// Só mascarado: o walletId inteiro não sai daqui.
	walletMasked: string | null;
	pct: string;
	amountCents: number;
	status: ChargeSplitStatus;
};

export type ClientLossRow = {
	clientId: string;
	clientName: string;
	totalPaidCents: number;
	refundCount: number;
	refundCents: number;
	chargebackCount: number;
	chargebackCents: number;
	// (estornos + chargebacks) sobre o total pago, em %, com 2 casas.
	refundPct: number;
	// Repasses do split do Asaas que o Asaas não reverteu (status reversal_failed) nas cobranças estornadas.
	reversalFailedCents: number;
	// Comissão de afiliado em modo Pix já liberada que o estorno cobrou de volta e deixou o saldo abaixo de zero.
	// shortcut: mede o saldo no momento do estorno; o que o afiliado repôs depois não é abatido.
	negativeBalanceCents: number;
};

type SplitDbRow = {
	id: string;
	pix_charge_id: string;
	bureau_id: string;
	bureau_name: string;
	created_at: Date;
	beneficiary_kind: BeneficiaryKind;
	beneficiary_name: string | null;
	payout_method: SplitReportRow["payoutMethod"];
	asaas_wallet_id: string | null;
	pct: string;
	amount_cents: string;
	status: ChargeSplitStatus;
};

type LossDbRow = {
	client_id: string;
	client_name: string;
	total_paid: string;
	refund_count: number;
	refund_cents: string;
	chargeback_count: number;
	chargeback_cents: string;
	reversal_failed_cents: string;
	negative_balance_cents: string;
};

const todayInSp = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

function validDate(value: string | undefined): string | null {
	if (!value || !DATE_PATTERN.test(value)) return null;
	const parsed = new Date(`${value}T00:00:00Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

// Datas da URL (de, ate: AAAA-MM-DD, fuso de São Paulo, o dia final entra inteiro). Valor inválido volta ao padrão.
export function parseReportRange(
	params: { de?: string; ate?: string },
	now: Date = new Date(),
): ReportRange & { fromDate: string; toDate: string } {
	const today = todayInSp(now);
	let toDate = validDate(params.ate) ?? today;
	let fromDate = validDate(params.de) ?? addDays(toDate, -DEFAULT_RANGE_DAYS);
	if (fromDate > toDate) {
		toDate = today;
		fromDate = addDays(today, -DEFAULT_RANGE_DAYS);
	}
	return { fromDate, toDate, from: `${fromDate}T00:00:00${SP_OFFSET}`, to: `${addDays(toDate, 1)}T00:00:00${SP_OFFSET}` };
}

export async function listBureauSplits(
	identity: DbIdentity,
	args: ReportRange & { status?: ChargeSplitStatus },
): Promise<SplitReportRow[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<SplitDbRow>(
			`select cs.id, cs.pix_charge_id, cs.bureau_id, b.name as bureau_name, cs.created_at, cs.beneficiary_kind,
			        case cs.beneficiary_kind when 'partner' then pp.name when 'affiliate' then pr.full_name else bn.name end as beneficiary_name,
			        cs.payout_method, cs.asaas_wallet_id, cs.pct::text, cs.amount_cents::text, cs.status
			   from charge_splits cs
			   join bureaus b on b.id = cs.bureau_id
			   left join platform_partners pp on cs.beneficiary_kind = 'partner' and pp.id = cs.beneficiary_id
			   left join profiles pr on cs.beneficiary_kind = 'affiliate' and pr.id = cs.beneficiary_id
			   left join bureaus bn on cs.beneficiary_kind in ('bureau', 'bureau_referrer') and bn.id = cs.beneficiary_id
			  where cs.created_at >= $1 and cs.created_at < $2 and ($3::text is null or cs.status = $3)
			  order by cs.created_at desc, cs.id
			  limit ${MAX_SPLIT_ROWS}`,
			[args.from, args.to, args.status ?? null],
		);
		return rows.map((r) => ({
			id: r.id,
			pixChargeId: r.pix_charge_id,
			bureauId: r.bureau_id,
			bureauName: r.bureau_name,
			createdAt: r.created_at,
			beneficiaryKind: r.beneficiary_kind,
			beneficiaryName: r.beneficiary_name,
			payoutMethod: r.payout_method,
			walletMasked: r.asaas_wallet_id ? maskWalletId(r.asaas_wallet_id) : null,
			pct: r.pct,
			amountCents: Number(r.amount_cents),
			status: r.status,
		}));
	});
}

// Total que foi para os sócios no período: pendente, feito ou sem reversão (o dinheiro saiu). Recusado e estornado
// voltaram para a plataforma. Só o superadmin lê as linhas dos sócios (RLS); para os demais o total é 0.
export async function getPartnerSplitTotal(identity: DbIdentity, args: ReportRange): Promise<number> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ cents: string }>(
			`select coalesce(sum(amount_cents), 0)::text as cents
			   from charge_splits
			  where beneficiary_kind = 'partner' and status in ('pending', 'done', 'reversal_failed')
			    and created_at >= $1 and created_at < $2`,
			[args.from, args.to],
		);
		return Number(rows[0].cents);
	});
}

const CHARGEBACK_EVENT = "PAYMENT_CHARGEBACK_REQUESTED";

export async function listClientLosses(identity: DbIdentity, args: ReportRange): Promise<ClientLossRow[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<LossDbRow>(
			`with ch as (
			   select pc.id, pc.client_profile_id, round(pc.amount * 100)::bigint as cents, pc.status,
			          exists (select 1 from asaas_webhook_events e
			                   where e.asaas_payment_id = pc.asaas_payment_id and e.bureau_id = pc.bureau_id
			                     and e.result = 'refunded' and e.event_type = $3) as chargeback,
			          exists (select 1 from asaas_webhook_events e
			                   where e.asaas_payment_id = pc.asaas_payment_id and e.bureau_id = pc.bureau_id
			                     and e.result = 'refunded') as reversed
			     from pix_charges pc
			    where pc.client_profile_id is not null and pc.bureau_id = app_bureau_id()
			      and pc.created_at >= $1 and pc.created_at < $2 and pc.status in ('paid', 'refunded')
			 ), paid as (
			   select * from ch where status = 'paid' or reversed
			 ), lost as (
			   select p.*,
			          coalesce((select sum(cs.amount_cents) from charge_splits cs
			                     where cs.pix_charge_id = p.id and cs.status = 'reversal_failed'), 0) as failed_cents,
			          coalesce((select sum(round(least(l.amount, greatest(-l.available_after, 0)) * 100))
			                      from affiliate_commissions ac
			                      join affiliate_ledger_entries l on l.reference = 'commission:' || ac.id::text
			                     where ac.order_ref = p.id and l.kind = 'commission_clawback'), 0) as negative_cents
			     from paid p where p.status = 'refunded'
			 )
			 select p.client_profile_id as client_id, pr.full_name as client_name,
			        sum(p.cents)::text as total_paid,
			        (count(*) filter (where p.status = 'refunded' and not p.chargeback))::int as refund_count,
			        (coalesce(sum(p.cents) filter (where p.status = 'refunded' and not p.chargeback), 0))::text as refund_cents,
			        (count(*) filter (where p.status = 'refunded' and p.chargeback))::int as chargeback_count,
			        (coalesce(sum(p.cents) filter (where p.status = 'refunded' and p.chargeback), 0))::text as chargeback_cents,
			        coalesce(sum(lost.failed_cents), 0)::text as reversal_failed_cents,
			        coalesce(sum(lost.negative_cents), 0)::text as negative_balance_cents
			   from paid p
			   join profiles pr on pr.id = p.client_profile_id
			   left join lost on lost.id = p.id
			  group by p.client_profile_id, pr.full_name
			  order by (coalesce(sum(p.cents) filter (where p.status = 'refunded'), 0))::numeric / nullif(sum(p.cents), 0) desc nulls last,
			           pr.full_name, p.client_profile_id`,
			[args.from, args.to, CHARGEBACK_EVENT],
		);
		return rows.map((r) => {
			const totalPaidCents = Number(r.total_paid);
			const refundCents = Number(r.refund_cents);
			const chargebackCents = Number(r.chargeback_cents);
			return {
				clientId: r.client_id,
				clientName: r.client_name,
				totalPaidCents,
				refundCount: r.refund_count,
				refundCents,
				chargebackCount: r.chargeback_count,
				chargebackCents,
				refundPct: totalPaidCents > 0 ? Math.round(((refundCents + chargebackCents) / totalPaidCents) * 10000) / 100 : 0,
				reversalFailedCents: Number(r.reversal_failed_cents),
				negativeBalanceCents: Number(r.negative_balance_cents),
			};
		});
	});
}
