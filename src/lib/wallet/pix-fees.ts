// Só tipos de config: importar valor de "@/lib/config" lê o ambiente na carga (quebra cliente e testes).
import type { PixFeeConfig } from "@/lib/config";

// Resumo de uma recarga para a tela: o que sobe no saldo, a taxa repassada e o que o pagador paga.
export type ChargeSummary = { rechargeCents: number; feeCents: number; totalCents: number };

export class PixFeeError extends Error {
  readonly code = "invalid_amount";
  constructor() {
    super("invalid_amount");
    this.name = "PixFeeError";
  }
}

// Pix: o pagador paga recarga + taxa fixa do Asaas. O saldo sobe só pela recarga. Tudo em centavos inteiros.
export function computePixCharge(config: PixFeeConfig, rechargeCents: number): ChargeSummary {
  if (!Number.isSafeInteger(rechargeCents) || rechargeCents < 1) throw new PixFeeError();
  return { rechargeCents, feeCents: config.feeCents, totalCents: rechargeCents + config.feeCents };
}
