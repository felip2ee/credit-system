import type { OrderPriceBreakdown } from "@/components/orders/order-rules";
import { formatCurrency } from "@/lib/utils";

// Empresa + sócios: mostra de onde vem o total, no preço que o Bureau cobra.
export function OrderPriceSummary({ breakdown, pricePerPartner }: { breakdown: OrderPriceBreakdown; pricePerPartner: number }) {
	const { baseCents, partnerCount, partnersCents, ignoredRows } = breakdown;
	return (
		<div className="space-y-1 text-sm">
			<div className="flex justify-between gap-4">
				<span className="text-muted-foreground">Empresa</span>
				<span className="tabular-nums">{formatCurrency(baseCents / 100)}</span>
			</div>
			<div className="flex justify-between gap-4">
				<span className="text-muted-foreground">
					Sócios: {partnerCount} {partnerCount === 1 ? "sócio" : "sócios"} × {formatCurrency(pricePerPartner)}
				</span>
				<span className="tabular-nums">{formatCurrency(partnersCents / 100)}</span>
			</div>
			{ignoredRows > 0 && (
				<p className="text-muted-foreground">
					{ignoredRows} {ignoredRows === 1 ? "sócio sem CPF completo ainda não entra" : "sócios sem CPF completo ainda não entram"} no valor.
				</p>
			)}
		</div>
	);
}
