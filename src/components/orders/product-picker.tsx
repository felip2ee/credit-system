import { ChevronDown } from "lucide-react";

import { isSelfOrder, productLabel, type HolderType } from "@/components/orders/order-rules";
import type { OrderProductCode } from "@/lib/orders/types";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { productCopy, productRules } from "@/lib/catalog/product-copy";
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

const SUBJECT_TITLE: Record<OrderProductCode, string> = {
	dossie_pf: "Pessoa física (CPF)",
	dossie_empresarial: "Empresa (CNPJ)",
};

// Um cartão de escolha por produto. O radio group do Radix já move a escolha com as setas do teclado.
// Título e resumo nunca são cortados: quebram de linha. min-w-0 evita estouro horizontal em 360 px.
export function ProductPicker({ products, value, onChange, holderType }: ProductPickerProps) {
	return (
		<RadioGroup aria-label="Para quem é a pesquisa?" value={value} onValueChange={(v) => onChange(v as OrderProductCode)}>
			{products.map((p) => {
				const copy = productCopy(p.code);
				const rules = productRules(p.code, isSelfOrder(p.code, holderType));
				return (
					<div
						key={p.code}
						className="min-w-0 rounded-card border border-input has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-brand-soft"
					>
						<label htmlFor={`product-${p.code}`} className="flex min-h-12 min-w-0 cursor-pointer items-start gap-3 p-3">
							<RadioGroupItem id={`product-${p.code}`} value={p.code} aria-describedby={`product-${p.code}-rules`} className="mt-1 shrink-0" />
							<span className="min-w-0 flex-1 space-y-1">
								<span className="block break-words font-bold">{SUBJECT_TITLE[p.code]}</span>
								<span className="block break-words text-sm text-muted-foreground">{productLabel(p.name, p.code, holderType)}</span>
								{copy && <span className="block break-words text-sm">{copy.summary}</span>}
								<span className="block text-sm font-medium tabular-nums">
									{p.code === "dossie_empresarial"
										? `${formatCurrency(Number(p.price))} por empresa + ${formatCurrency(Number(p.pricePerPartner))} por sócio`
										: formatCurrency(Number(p.price))}
								</span>
							</span>
						</label>
						<div className="space-y-1 px-3 pb-3 pl-12">
							<div id={`product-${p.code}-rules`} className="space-y-1">
								<p className="text-sm font-bold">O que você pode e não pode</p>
								<ul className="list-disc space-y-1 pl-5 text-sm">
									{rules.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</div>
							{copy && (
								<details className="group">
									<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold text-primary [&::-webkit-details-marker]:hidden">
										O que você recebe
										<ChevronDown aria-hidden className="size-5 shrink-0 transition-transform group-open:rotate-180" />
									</summary>
									<ul className="list-disc space-y-1 pb-2 pl-5 text-sm">
										{copy.includes.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								</details>
							)}
						</div>
					</div>
				);
			})}
		</RadioGroup>
	);
}
