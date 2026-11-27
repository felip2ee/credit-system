export type AffiliateWallet = { pending: string; available: string };

export type CommissionStatus = "pending" | "released" | "reversed";

export type AffiliateCommissionRow = {
	createdAt: string;
	referredName: string;
	productName: string;
	orderValue: string;
	amount: string;
	status: CommissionStatus;
	releaseAt: string;
};

export type AffiliateReferralRow = { name: string; createdAt: string; totalSpent: string };

export type PayoutMethod = "asaas" | "pix";

export type BeneficiaryKind = "partner" | "bureau" | "bureau_referrer" | "affiliate";

export type ChargeSplitStatus = "pending" | "done" | "refused" | "refunded" | "reversal_failed";
