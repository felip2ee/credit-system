// Dinheiro em reais como string decimal; a comparação usa centavos inteiros (nunca ponto flutuante).
const MAX_CENTS = 9_999_999_999; // 99999999.99
const DECIMAL = /^\d{1,8}(\.\d{1,2})?$/;

// Aceita 0: custo e valor por sócio podem ser 0.00; o preço de venda base é validado > 0 nos validadores.
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

// Regra de preço de um campo: o preço não pode ficar abaixo do custo (custo 0 é válido).
export function isPriceSellable(priceCents: number, costCents: number): boolean {
  return priceCents >= costCents;
}
