export type AffiliateWallet = { pending: string; available: string };

export type CommissionStatus = "pending" | "released" | "reversed";

type CommissionBase = {
	createdAt: string;
	referredName: string;
	productName: string;
	// Valor da recarga ou, em comissão antiga, do pedido. Nulo quando nenhum dos dois existe.
	baseValue: string | null;
	fromRecharge: boolean;
	amount: string;
};

// "wallet": comissão na carteira do sistema (Pix ou pedido antigo). "asaas": paga pelo split na conta Asaas do afiliado.
export type AffiliateCommissionRow = CommissionBase &
	({ paidBy: "wallet"; status: CommissionStatus; releaseAt: string } | { paidBy: "asaas"; status: ChargeSplitStatus });

export type AffiliateReferralRow = { name: string; createdAt: string; recharged: string };

export type PayoutMethod = "asaas" | "pix";

export type BeneficiaryKind = "partner" | "bureau" | "bureau_referrer" | "affiliate";

export type ChargeSplitStatus = "pending" | "done" | "refused" | "refunded" | "reversal_failed";
