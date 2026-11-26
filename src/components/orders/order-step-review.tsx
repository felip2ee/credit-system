"use client";

import { Controller, useFormContext } from "react-hook-form";

import { CouponField, type useCoupon } from "@/components/orders/coupon-field";
import { OrderPriceSummary } from "@/components/orders/order-price-summary";
import type { OrderPriceBreakdown } from "@/components/orders/order-rules";
import type { OrderFormValues } from "@/components/orders/order-wizard-steps";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { maskDocument } from "@/lib/mask-document";
import type { OrderProductCode } from "@/lib/orders/types";
import { failureMessage } from "@/lib/ui/failure-message";
import { formatCurrency } from "@/lib/utils";

import type { ClientOrderProduct } from "./client-order-form";

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

export interface ReviewStepProps {
	product: ClientOrderProduct;
	productCode: OrderProductCode;
	// Nulo na pesquisa própria.
	subject: { name: string; document: string } | null;
	// Já passada por billablePartners: é a lista que o servidor cobra.
	people: OrderFormValues["partners"];
	breakdown: OrderPriceBreakdown | null;
	coupon: ReturnType<typeof useCoupon>;
	totalCents: number;
	hasMembers: boolean;
	declaration: { version: number; title: string; bodyMd: string };
	// Documento mascarado da conta, para a pesquisa própria.
	selfDocumentMasked: string | null;
	serverError: string | null;
}

export function ReviewStep({ product, productCode, subject, people, breakdown, coupon, totalCents, hasMembers, declaration, selfDocumentMasked, serverError }: ReviewStepProps) {
	const { control } = useFormContext<OrderFormValues>();
	const isEmpresarial = productCode === "dossie_empresarial";

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<p className="font-bold">{product.name}</p>
				{subject === null && selfDocumentMasked !== null && (
					<p className="text-base text-muted-foreground">
						A pesquisa é sobre você ({selfDocumentMasked}). Você recebe um pedido de autorização por e-mail.
					</p>
				)}
				{subject && (
					<p className="break-words text-base">
						{subject.name} ({maskDocument(isEmpresarial ? "PJ" : "PF", subject.document)})
					</p>
				)}
			</div>
			{isEmpresarial && (
				<section aria-label="Pessoas da pesquisa" className="space-y-2">
					<h3 className="font-bold">Pessoas ({people.length})</h3>
					{people.length === 0 ? (
						<p className="text-base text-muted-foreground">Nenhuma pessoa na lista. Volte e adicione quem autoriza a consulta.</p>
					) : (
						<ul className="space-y-2">
							{people.map((p) => (
								<li key={`${p.document}-${p.email}`} className="min-w-0 rounded-card border border-border bg-muted p-3 text-base">
									<span className="block break-words font-medium">{p.name}</span>
									<span className="block break-words text-muted-foreground">
										{maskDocument("PF", p.document)} · {p.email}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			)}
			{hasMembers && (
				<div className="space-y-2">
					<p className="whitespace-pre-line rounded-card border border-border bg-muted p-3 text-base" id="declaration-text">
						{declaration.bodyMd}
					</p>
					<div className="flex min-h-11 items-start gap-3">
						<Controller
							control={control}
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
			{isEmpresarial && breakdown && <OrderPriceSummary breakdown={breakdown} pricePerPartner={Number(product.pricePerPartner)} />}
			<CouponField coupon={coupon} />
			<dl>
				<dt className="text-muted-foreground">Total</dt>
				<dd className="text-2xl font-bold tabular-nums" aria-live="polite">
					{formatCurrency(totalCents / 100)}
				</dd>
			</dl>
			{serverError && <FailureBanner what={serverError} next="Revise os dados e tente de novo." />}
		</div>
	);
}
