import { formatCurrency } from "@/lib/utils";
import type { ChargeSummary } from "@/lib/wallet/pix-fees";

// Regras de texto e valor do resumo do Pix (sem DOM). Tudo em centavos inteiros; só a exibição divide por 100.
export const PIX_UNAVAILABLE = "Pix indisponível no momento. Tente o cartão ou fale com o suporte.";
export const PAYMENT_UNAVAILABLE = "Pagamento indisponível no momento. Fale com o suporte.";

export const formatCents = (cents: number): string => formatCurrency(cents / 100);

/** Resumo com taxa só quando há taxa e ele vale para o valor digitado (evita mostrar número velho durante o debounce). */
export function pixSummaryFor(charge: ChargeSummary | null | undefined, amountCents: number): ChargeSummary | null {
  return charge && charge.feeCents > 0 && charge.rechargeCents === amountCents ? charge : null;
}

export const pixSummaryLine = (s: ChargeSummary): string =>
  `Recarga ${formatCents(s.rechargeCents)} + taxa do Pix ${formatCents(s.feeCents)} = você paga ${formatCents(s.totalCents)}`;

export const pixSubmitLabel = (s: ChargeSummary | null): string => (s ? `Pagar ${formatCents(s.totalCents)} com Pix` : "Gerar PIX");

/** Linha pequena do QR; vazia sem taxa. */
export const pixQrNote = (s: ChargeSummary | undefined): string | null =>
  s && s.feeCents > 0 ? `Inclui taxa do Pix de ${formatCents(s.feeCents)}; seu saldo recebe ${formatCents(s.rechargeCents)}.` : null;

/** null = há alguma forma disponível. */
export function unavailableMessage(pixEnabled: boolean, cardEnabled: boolean): string | null {
  if (pixEnabled) return null;
  return cardEnabled ? PIX_UNAVAILABLE : PAYMENT_UNAVAILABLE;
}
