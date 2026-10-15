// Dinheiro em reais como string decimal; a comparação usa centavos inteiros (nunca ponto flutuante).
const MAX_CENTS = 9_999_999_999; // 99999999.99
const DECIMAL = /^\d{1,8}(\.\d{1,2})?$/;

// Aceita 0 porque o banco guarda "0.00" para custo não definido; os validadores exigem > 0.
export function toCents(value: string): number {
  if (!DECIMAL.test(value)) throw new RangeError("Valor monetário inválido.");
  const [reais, fraction = ""] = value.split(".");
  const cents = Number(reais) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents > MAX_CENTS) throw new RangeError("Valor monetário fora da faixa.");
  return cents;
}

export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) {
    throw new RangeError("Valor em centavos fora da faixa.");
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// Custo zero = custo não definido: o item não entra à venda.
export function isPriceSellable(priceCents: number, costCents: number): boolean {
  return costCents > 0 && priceCents >= costCents;
}
