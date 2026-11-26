import { toCents } from "@/lib/catalog/money";
import { MAX_PARTNERS } from "@/lib/validators/order";
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from "@/lib/validators/wallet";

export type ReferencePriceRow = { key: string; label: string; cents: number };

// Quantidades de sócios mostradas na tabela de referência.
const PARTNER_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

type Item = { salePrice: string; salePricePerPartner: string };

// Preço de venda do dossiê, em centavos, como o formulário de pedido cota: base + N x preço por sócio.
// Produto ausente (não está à venda) = sem linhas dele.
export function referencePriceRows(
	pf: { salePrice: string } | null | undefined,
	pj: Item | null | undefined,
	maxPartners: number = MAX_PARTNERS,
): ReferencePriceRow[] {
	const rows: ReferencePriceRow[] = [];
	if (pf) rows.push({ key: "pf", label: "Dossiê Pessoa Física", cents: toCents(pf.salePrice) });
	if (pj) {
		const base = toCents(pj.salePrice);
		const perPartner = toCents(pj.salePricePerPartner);
		for (const n of PARTNER_COUNTS) {
			if (n > maxPartners) break;
			rows.push({ key: `pj-${n}`, label: `Dossiê Empresarial + ${n} ${n === 1 ? "sócio" : "sócios"}`, cents: base + n * perPartner });
		}
	}
	return rows;
}

export const isTopupAmountCents = (cents: number): boolean => cents >= MIN_TOPUP_CENTS && cents <= MAX_TOPUP_CENTS;
