import { BuyerPicker, type Buyer } from "@/components/dossiers/buyer-picker";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { formatCurrency } from "@/lib/utils";

export interface CatalogOption {
	code: string;
	name: string;
	// Preço de venda do catálogo, decimal em string. Nunca digitado pelo operador.
	price: string;
	// Valor por sócio do catálogo; só vale no Dossiê Empresarial.
	pricePerPartner: string;
}

export const EMPRESARIAL_PRODUCT = "dossie_empresarial";

interface DossierProductStepProps {
	products: CatalogOption[];
	value: string;
	onChange: (code: string) => void;
	buyer: Buyer | null;
	onBuyerChange: (buyer: Buyer | null) => void;
}

// Etapa "Produto e comprador". O radio group do Radix move a escolha com as setas do teclado e mantém um só item no Tab.
export function DossierProductStep({ products, value, onChange, buyer, onBuyerChange }: DossierProductStepProps) {
	return (
		<>
			<RadioGroup aria-label="Produto" value={value} onValueChange={onChange}>
				{products.map((p) => (
					<div
						key={p.code}
						className="min-w-0 rounded-card border border-input has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-brand-soft"
					>
						<label htmlFor={`product-${p.code}`} className="flex min-h-12 min-w-0 cursor-pointer items-start gap-3 p-3">
							<RadioGroupItem id={`product-${p.code}`} value={p.code} className="mt-1 shrink-0" />
							<span className="min-w-0 flex-1 space-y-1">
								<span className="block break-words font-bold">{p.name}</span>
								<span className="block text-sm font-medium tabular-nums">{formatCurrency(Number(p.price))}</span>
								{p.code === EMPRESARIAL_PRODUCT && (
									<span className="block text-sm text-muted-foreground">
										+ {formatCurrency(Number(p.pricePerPartner))} por sócio ou cônjuge
									</span>
								)}
							</span>
						</label>
					</div>
				))}
			</RadioGroup>
			<BuyerPicker value={buyer} onChange={onBuyerChange} />
		</>
	);
}
