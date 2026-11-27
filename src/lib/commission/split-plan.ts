// Plano de split de uma cobrança Asaas (migração 068). O cálculo das camadas (sócios, bureau, bureau indicador, afiliado de
// link), o teto de 100% e a gravação em charge_splits (pending) rodam no banco, a partir da cobrança: quem chama não
// escolhe beneficiário, walletId, percentual nem valor. Aqui só se chama o banco e se separa o resultado por destino.
// Nenhuma chamada HTTP roda aqui: o plano vem antes do Asaas, na mesma transação da reserva da cobrança.
import type { PoolClient } from "pg";

import type { AsaasSplitItem } from "@/lib/asaas";
import type { BeneficiaryKind } from "@/lib/affiliates/types";
import { SplitOver100Error } from "./queries";

export type SplitPayout = "asaas" | "pix" | "accrual";

// Uma linha do plano. pct vem do banco (numeric): fica em número para o corpo do Asaas.
export type SplitLine = {
	kind: BeneficiaryKind;
	beneficiaryId: string;
	payoutMethod: SplitPayout;
	walletId: string | null;
	pct: number;
	amountCents: number;
};

// Beneficiários em modo Pix (só o afiliado de link). Viram lançamento na confirmação do pagamento.
export type PixCashInLine = SplitLine & { payoutMethod: "pix" };
// Bureau (dono ou indicador) sem walletId: vira accrual em bureau_payable_entries na confirmação (C2).
export type BureauAccrualLine = SplitLine & { payoutMethod: "accrual" };

export type SplitPlan = {
	asaasSplit: AsaasSplitItem[];
	pixLines: PixCashInLine[];
	accrualLines: BureauAccrualLine[];
};

type PlanRow = {
	beneficiary_kind: BeneficiaryKind;
	beneficiary_id: string;
	payout_method: SplitPayout;
	asaas_wallet_id: string | null;
	pct: string;
	amount_cents: string;
};

export function toSplitPlan(rows: PlanRow[]): SplitPlan {
	const lines: SplitLine[] = rows.map((r) => ({
		kind: r.beneficiary_kind,
		beneficiaryId: r.beneficiary_id,
		payoutMethod: r.payout_method,
		walletId: r.asaas_wallet_id,
		pct: Number(r.pct),
		amountCents: Number(r.amount_cents),
	}));
	return {
		asaasSplit: lines.flatMap((l) => (l.payoutMethod === "asaas" && l.walletId ? [{ walletId: l.walletId, percentualValue: l.pct }] : [])),
		pixLines: lines.filter((l): l is PixCashInLine => l.payoutMethod === "pix"),
		accrualLines: lines.filter((l): l is BureauAccrualLine => l.payoutMethod === "accrual"),
	};
}

type Queryable = Pick<PoolClient, "query">;

async function plan(db: Queryable, fn: "charge_split_plan" | "payment_link_charge_split", chargeId: string): Promise<SplitPlan> {
	try {
		const { rows } = await db.query<PlanRow>(`select * from public.${fn}($1)`, [chargeId]);
		return toSplitPlan(rows);
	} catch (error) {
		if (error instanceof Error && error.message.includes("split_over_100")) throw new SplitOver100Error();
		throw error;
	}
}

// Checkout de recarga (Pix e cartão): chame logo depois de reserveCharge, na MESMA transação (o rollback desfaz a linha
// da cobrança e o plano). Só o autor da cobrança pendente do próprio bureau. Cobrança de recarga do próprio bureau: só sócios.
export const buildSplitPlan = (client: PoolClient, chargeId: string): Promise<SplitPlan> =>
	plan(client, "charge_split_plan", chargeId);

// Link de pagamento (sem sessão): depois de payment_link_charge_reserve e antes de chamar o Asaas.
export const buildLinkSplitPlan = (db: Queryable, chargeId: string): Promise<SplitPlan> =>
	plan(db, "payment_link_charge_split", chargeId);

// Asaas recusou o split e a cobrança segue sem ele (079): as linhas asaas pendentes viram `refused`.
export const markSplitRefused = (db: Queryable, chargeId: string) =>
	db.query("select public.charge_split_mark_refused($1)", [chargeId]);
