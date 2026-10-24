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
