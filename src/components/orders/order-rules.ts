// Regras de tela do pedido, sem React: o que cada conta vê, o total ao vivo e quando o cliente pode cancelar.
import { buildQuote } from "@/lib/catalog/build-quote";
import { toCents } from "@/lib/catalog/money";
import type { OrderMember, OrderMemberScrStatus } from "@/lib/orders/client-ops";
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
		},
		partnerCount,
	).totalPriceCents;
}

const CPF_DIGITS = 11;
const digitsOf = (value: string | undefined): string => (value ?? "").replace(/\D/g, "");

// Linhas que o servidor cobra: CPF completo, distinto (vale a 1ª), e diferente do documento da empresa. Linha vazia ou incompleta não conta.
export function billablePartners<T extends { document?: string }>(partners: T[], companyDocument?: string): T[] {
	const seen = new Set<string>([digitsOf(companyDocument)]);
	return partners.filter((partner) => {
		const digits = digitsOf(partner.document);
		if (digits.length !== CPF_DIGITS || seen.has(digits)) return false;
		seen.add(digits);
		return true;
	});
}

export function countBillablePartners(partners: { document?: string }[], companyDocument?: string): number {
	return billablePartners(partners, companyDocument).length;
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

// O comprador só entra como pessoa na conta PF: o e-mail da conta vale para o CPF do Titular.
export const canAddSelf = (holderType: HolderType): boolean => holderType === "PF";

export function hasBuyerRow(partners: { email?: string }[], buyerEmail: string): boolean {
	const buyer = buyerEmail.trim().toLowerCase();
	return buyer !== "" && partners.some((p) => (p.email ?? "").trim().toLowerCase() === buyer);
}

export function choiceTitle(productCode: OrderProductCode, holderType: HolderType): string {
	if (productCode === "dossie_empresarial") return "Para uma empresa";
	return isSelfOrder(productCode, holderType) ? "Só para você" : "Para o responsável da empresa";
}

export const reviewActionLabel = (totalCents: number): string => (totalCents > 0 ? "Ir para o pagamento" : "Confirmar pedido");

// Texto de apoio por pessoa na seção Autorizações; nulo quando não há o que dizer.
export function memberActionHint(
	m: Pick<OrderMember, "scrStatus" | "canEditEmail" | "canResend" | "changesLeft">,
): string | null {
	if (m.scrStatus !== "pending") return null;
	if (m.changesLeft === 0) return "Limite de envios de hoje atingido. Tente amanhã.";
	if (m.canEditEmail || m.canResend) {
		return m.changesLeft === 1 ? "Resta 1 envio hoje." : `Restam ${m.changesLeft} envios hoje.`;
	}
	return "E-mail da sua conta.";
}
