// Regras de tela do pedido, sem React: o que cada conta vê, o total ao vivo e quando o cliente pode cancelar.
import { buildQuote } from "@/lib/catalog/build-quote";
import { toCents } from "@/lib/catalog/money";
import type { OrderMemberScrStatus } from "@/lib/orders/client-ops";
import type { OrderMode, OrderProductCode, OrderState } from "@/lib/orders/types";

export type HolderType = "PF" | "PJ" | null;

export interface ProductPrices {
	code: OrderProductCode;
	// Decimais em string, como vêm do catálogo.
	price: string;
	pricePerPartner: string;
}

export function orderTotalCents(product: ProductPrices, partnerCount: number): number {
	return buildQuote(
		{
			productVersionId: "",
			code: product.code,
			salePriceCents: toCents(product.price),
			salePricePerPartnerCents: toCents(product.pricePerPartner),
			costCents: 0,
			costPerPartnerCents: 0,
		},
		partnerCount,
	).totalPriceCents;
}

const CPF_DIGITS = 11;
const digitsOf = (value: string | undefined): string => (value ?? "").replace(/\D/g, "");

// Sócios que o servidor cobra: CPF completo, distinto, e diferente do documento da empresa. Linha vazia ou incompleta não conta.
export function countBillablePartners(partners: { document?: string }[], companyDocument?: string): number {
	const company = digitsOf(companyDocument);
	const seen = new Set<string>();
	for (const partner of partners) {
		const digits = digitsOf(partner.document);
		if (digits.length === CPF_DIGITS && digits !== company) seen.add(digits);
	}
	return seen.size;
}

export interface OrderPriceBreakdown {
	baseCents: number;
	partnerCount: number;
	partnersCents: number;
	// Linhas de sócio que ainda não entram no valor (vazia, incompleta, repetida ou igual à empresa).
	ignoredRows: number;
	totalCents: number;
}

// Mesmo cálculo do total cobrado, aberto em empresa + sócios para a tela mostrar de onde vem o valor.
export function orderPriceBreakdown(
	product: ProductPrices,
	partners: { document?: string }[],
	companyDocument?: string,
): OrderPriceBreakdown {
	const partnerCount = countBillablePartners(partners, companyDocument);
	const totalCents = orderTotalCents(product, partnerCount);
	const baseCents = orderTotalCents(product, 0);
	return {
		baseCents,
		partnerCount,
		partnersCents: totalCents - baseCents,
		ignoredRows: partners.length - partnerCount,
		totalCents,
	};
}

// Dossiê Pessoa Física só pesquisa o próprio titular, salvo a conta PJ, que informa o responsável.
export function isSelfOrder(productCode: OrderProductCode, holderType: HolderType): boolean {
	return productCode === "dossie_pf" && holderType !== "PJ";
}

// Pedido com CPF de outras pessoas: exige a declaração do comprador.
export function orderHasMembers(productCode: OrderProductCode, holderType: HolderType): boolean {
	return productCode === "dossie_empresarial" || !isSelfOrder(productCode, holderType);
}

export function canConfirmOrder(input: { hasMembers: boolean; declarationAccepted: boolean }): boolean {
	return !input.hasMembers || input.declarationAccepted;
}

export function productLabel(name: string, productCode: OrderProductCode, holderType: HolderType): string {
	return isSelfOrder(productCode, holderType) ? `${name} (você)` : name;
}

const CANCELLABLE_STATES: OrderState[] = ["awaiting_authorization", "ready"];

// Só o pedido online: no balcão o cliente pagou à parte e quem cancela é a equipe.
export function canCancelOrder(state: OrderState, mode: OrderMode): boolean {
	return mode === "online" && CANCELLABLE_STATES.includes(state);
}

// Um membro recusou ou venceu: o pedido não roda mais.
export function orderIsBlocked(statuses: OrderMemberScrStatus[]): boolean {
	return statuses.some((s) => s === "refused" || s === "expired");
}

const BLOCKED_ONLINE_MESSAGE = "Este pedido não vai rodar. Cancele para receber o valor de volta.";
const BLOCKED_COUNTER_MESSAGE = "Este pedido não vai rodar. Fale com o Bureau.";

// Só o pedido online tem botão de cancelar: no balcão a saída é falar com o Bureau.
export function blockedOrderMessage(mode: OrderMode): string {
	return mode === "online" ? BLOCKED_ONLINE_MESSAGE : BLOCKED_COUNTER_MESSAGE;
}
