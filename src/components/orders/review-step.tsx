import { Controller, type UseFormReturn } from "react-hook-form";

import { isSelfOrder, orderHasMembers, productLabel, type HolderType, type OrderPriceBreakdown } from "@/components/orders/order-rules";
import { CouponField, type useCoupon } from "@/components/orders/coupon-field";
import { OrderPriceSummary } from "@/components/orders/order-price-summary";
import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { maskDocumentValue } from "@/lib/mask-document";
import { failureMessage } from "@/lib/ui/failure-message";
import { formatCurrency } from "@/lib/utils";

interface ReviewStepProps {
	form: UseFormReturn<OrderFormValues>;
	values: OrderFormValues;
	productName: string;
	holderType: HolderType;
	selfDocumentMasked: string | null;
	declarationBody: string;
	breakdown: OrderPriceBreakdown | null;
	pricePerPartner: number | null;
	coupon: ReturnType<typeof useCoupon>;
	available: string;
	insufficient: boolean;
	serverError: string | null;
}

function FailureBanner({ what, next }: { what: string; next: string }) {
	const msg = failureMessage({ what, money: "not_charged", next });
	return (
		<StatusBanner
			tone="attention"
			title={msg.title}
			description={
				<>
					<p>{msg.money}</p>
					<p>{msg.next}</p>
				</>
			}
		/>
	);
}

// Etapa final: resumo (documentos sempre mascarados), declaração, cupom, total e saldo.
export function ReviewStep(props: ReviewStepProps) {
	const { form, values, productName, holderType, selfDocumentMasked, declarationBody } = props;
	const isSelf = isSelfOrder(values.productCode, holderType);
	const hasMembers = orderHasMembers(values.productCode, holderType);
	const { breakdown, pricePerPartner, coupon, available, insufficient, serverError } = props;
	const empresarial = values.productCode === "dossie_empresarial";

	return (
		<div className="space-y-4">
			<dl className="space-y-3 rounded-card border border-border bg-muted p-3 text-base">
				<div>
					<dt className="text-sm text-muted-foreground">Produto</dt>
					<dd className="font-bold">{productLabel(productName, values.productCode, holderType)}</dd>
				</div>
				<div>
					<dt className="text-sm text-muted-foreground">{empresarial ? "Empresa" : "Pesquisa sobre"}</dt>
					<dd className="break-words font-bold">
						{isSelf ? `Você${selfDocumentMasked ? ` (${selfDocumentMasked})` : ""}` : `${values.subject.name} (${maskDocumentValue(values.subject.document)})`}
					</dd>
				</div>
				{empresarial && (
					<div>
						<dt className="text-sm text-muted-foreground">Sócios</dt>
						<dd>
							{values.partners.length === 0 ? (
								"Nenhum sócio. A pesquisa é só da empresa."
							) : (
								<ul className="space-y-1">
									{values.partners.map((p, i) => (
										<li key={`partner-${i}`} className="break-words font-bold">
											{p.name} ({maskDocumentValue(p.document)})
										</li>
									))}
								</ul>
							)}
						</dd>
					</div>
				)}
			</dl>
			{hasMembers && (
				<div className="space-y-2">
					<p className="whitespace-pre-line rounded-card border border-border bg-muted p-3 text-base" id="declaration-text">
						{declarationBody}
					</p>
					<div className="flex min-h-12 items-start gap-3">
						<Controller
							control={form.control}
							name="declarationAccepted"
							render={({ field }) => (
								<Checkbox
									id="declaration-accepted"
									className="mt-1"
									aria-describedby="declaration-text"
									checked={field.value}
									onCheckedChange={(checked) => field.onChange(checked === true)}
								/>
							)}
						/>
						<Label htmlFor="declaration-accepted" className="cursor-pointer text-base font-normal">
							Li e concordo com a declaração acima.
						</Label>
					</div>
				</div>
			)}
			{empresarial && breakdown && pricePerPartner !== null && <OrderPriceSummary breakdown={breakdown} pricePerPartner={pricePerPartner} />}
			<CouponField coupon={coupon} />
			<dl className="grid grid-cols-2 gap-4">
				<div>
					<dt className="text-muted-foreground">Total</dt>
					<dd className="text-2xl font-bold tabular-nums" aria-live="polite">
						{formatCurrency(coupon.totalCents / 100)}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Saldo disponível</dt>
					<dd className="text-2xl font-bold tabular-nums">{formatCurrency(Number(available))}</dd>
				</div>
			</dl>
			{insufficient && (
				<StatusBanner tone="attention" title="Saldo insuficiente para este pedido." description="Nada foi cobrado. Compre créditos e volte para confirmar." />
			)}
			{serverError && <FailureBanner what={serverError} next="Revise os dados e tente de novo." />}
		</div>
	);
}
