"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { Loader2 } from "lucide-react";

import { previewCouponAction } from "@/actions/coupons";
import {
	couponCodeForSubmit,
	couponReducer,
	displayedTotalCents,
	IDLE_COUPON,
	isCouponStale,
	normalizeCouponCode,
	type CouponQuoteKey,
	type CouponState,
} from "@/components/orders/coupon-field-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";

const PREVIEW_FAILED = "Não foi possível aplicar o cupom.";

// Estado do cupom + prévia. Se produto ou sócios mudam depois de aplicar, a prévia roda de novo.
export function useCoupon(key: CouponQuoteKey, listCents: number) {
	const [state, dispatch] = useReducer(couponReducer, IDLE_COUPON);
	const [text, setText] = useState("");
	const { productCode, partners } = key;

	const run = useCallback(
		async (code: string, quoteKey: CouponQuoteKey) => {
			dispatch({ type: "apply", code, key: quoteKey });
			const result = await previewCouponAction({ productCode: quoteKey.productCode, partners: quoteKey.partners, couponCode: code }).catch(
				() => ({ error: PREVIEW_FAILED }),
			);
			dispatch({ type: "resolved", code, key: quoteKey, result });
		},
		[],
	);

	useEffect(() => {
		if (state.status === "applied" && isCouponStale(state, { productCode, partners })) void run(state.code, { productCode, partners });
	}, [state, productCode, partners, run]);

	return {
		state,
		text,
		onText: (value: string) => {
			setText(value);
			dispatch({ type: "edit" });
		},
		apply: () => {
			const code = normalizeCouponCode(text);
			setText(code);
			void run(code, { productCode, partners });
		},
		remove: () => {
			dispatch({ type: "remove" });
			setText("");
		},
		couponCode: couponCodeForSubmit(state, key),
		totalCents: displayedTotalCents(state, key, listCents),
	};
}

interface CouponFieldProps {
	coupon: ReturnType<typeof useCoupon>;
}

function AppliedSummary({ state, code, onRemove }: { state: Extract<CouponState, { status: "applied" }>; code: string; onRemove: () => void }) {
	return (
		<div className="space-y-2" aria-live="polite">
			<dl className="space-y-1 text-base">
				<div className="flex justify-between gap-4">
					<dt className="text-muted-foreground">Preço de tabela</dt>
					<dd className="tabular-nums">{formatCurrency(state.listCents / 100)}</dd>
				</div>
				<div className="flex justify-between gap-4">
					<dt className="text-muted-foreground">Desconto (cupom {code})</dt>
					<dd className="tabular-nums">- {formatCurrency(state.discountCents / 100)}</dd>
				</div>
				<div className="flex justify-between gap-4 font-bold">
					<dt>Total</dt>
					<dd className="tabular-nums">{formatCurrency(state.paidCents / 100)}</dd>
				</div>
			</dl>
			<Button type="button" variant="outline" onClick={onRemove} aria-label={`Remover cupom ${code}`}>
				Remover
			</Button>
		</div>
	);
}

export function CouponField({ coupon }: CouponFieldProps) {
	const { state } = coupon;
	const applying = state.status === "applying";
	const errorId = "coupon-error";

	if (state.status === "applied") {
		return <AppliedSummary state={state} code={state.code} onRemove={coupon.remove} />;
	}

	return (
		<div className="space-y-2">
			<Label htmlFor="coupon-code">Cupom</Label>
			<div className="flex gap-2">
				<Input
					id="coupon-code"
					autoComplete="off"
					autoCapitalize="characters"
					spellCheck={false}
					maxLength={64}
					value={applying ? state.code : coupon.text}
					disabled={applying}
					aria-invalid={state.status === "error"}
					aria-describedby={state.status === "error" ? errorId : undefined}
					onChange={(event) => coupon.onText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						if (normalizeCouponCode(coupon.text)) coupon.apply();
					}}
				/>
				<Button type="button" variant="outline" disabled={applying || !normalizeCouponCode(coupon.text)} onClick={coupon.apply}>
					{applying && <Loader2 aria-hidden className="animate-spin" />}
					{applying ? "Aplicando..." : "Aplicar"}
				</Button>
			</div>
			{state.status === "error" && (
				<p id={errorId} role="alert" className="text-base text-destructive">
					{state.message}
				</p>
			)}
		</div>
	);
}
