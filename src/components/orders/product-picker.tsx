import { ChevronDown } from "lucide-react";

import { choiceTitle, type HolderType } from "@/components/orders/order-rules";
import type { OrderProductCode } from "@/lib/orders/types";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { productCopy } from "@/lib/catalog/product-copy";
import { formatCurrency } from "@/lib/utils";

interface ProductPickerProduct {
	code: OrderProductCode;
	name: string;
	price: string;
	pricePerPartner: string;
}

interface ProductPickerProps {
	products: ProductPickerProduct[];
	value: string;
	onChange: (code: OrderProductCode) => void;
	holderType: HolderType;
}

// Título e resumo nunca são cortados: quebram de linha. min-w-0 evita estouro horizontal em 360 px.
export function ProductPicker({ products, value, onChange, holderType }: ProductPickerProps) {
	return (
		<RadioGroup aria-label="Produto" value={value} onValueChange={(v) => onChange(v as OrderProductCode)}>
			{products.map((p) => {
				const copy = productCopy(p.code);
				return (
					<div key={p.code} className="min-w-0 space-y-1">
						<label
							htmlFor={`product-${p.code}`}
							className="flex min-h-11 min-w-0 cursor-pointer flex-col gap-1 rounded-card border border-input p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-brand-soft sm:flex-row sm:items-center sm:justify-between sm:gap-3"
						>
							<span className="flex min-w-0 items-start gap-3">
								<RadioGroupItem id={`product-${p.code}`} value={p.code} className="mt-1 shrink-0" />
								<span className="min-w-0">
									<span className="block break-words font-bold">{choiceTitle(p.code, holderType)}</span>
									<span className="block break-words text-sm text-muted-foreground">{p.name}</span>
								</span>
							</span>
							<span className="pl-9 text-sm font-medium tabular-nums text-muted-foreground sm:shrink-0 sm:pl-0 sm:text-right">
								{p.code === "dossie_empresarial" ? (
									<>
										{formatCurrency(Number(p.price))} por empresa
										<br />+ {formatCurrency(Number(p.pricePerPartner))} por pessoa
									</>
								) : (
									formatCurrency(Number(p.price))
								)}
							</span>
						</label>
						{copy && (
							<details className="group px-3">
								<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold text-primary [&::-webkit-details-marker]:hidden">
									O que você recebe
									<ChevronDown aria-hidden className="size-5 shrink-0 transition-transform group-open:rotate-180" />
								</summary>
								<ul className="list-disc space-y-1 pb-2 pl-5 text-base">
									{copy.includes.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</details>
						)}
					</div>
				);
			})}
		</RadioGroup>
	);
}
