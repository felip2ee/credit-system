import { formatCurrency } from "@/lib/utils";

// Valor em texto numérico do banco ("12.30", "-5.00") para reais: passa por centavos inteiros, sem resto de ponto flutuante.
export function formatMoney(value: string): string {
  return formatCurrency(Math.round(Number(value) * 100) / 100);
}

// Mesmo valor, com sinal explícito: "+R$ 10,00" ou "−R$ 10,00".
export function formatSignedMoney(value: string): string {
  const cents = Math.round(Number(value) * 100);
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(cents) / 100)}`;
}
