// Só tipos de config: importar valor de "@/lib/config" lê o ambiente na carga (quebra cliente e testes).
import type { CardFeeBand, CardFeeConfig } from "@/lib/config";

export const MAX_CARD_INSTALLMENTS = 12;

export type CardFeeErrorCode = "invalid_amount" | "installments_out_of_range" | "installment_below_minimum";

export class CardFeeError extends Error {
  constructor(readonly code: CardFeeErrorCode) {
    super(code);
    this.name = "CardFeeError";
  }
}

// Percentual em centésimos de ponto percentual (3.49 -> 349): a conta inteira evita erro de ponto flutuante.
const PERCENT_SCALE = 100;
const FULL = 100 * PERCENT_SCALE;

function bandFor(config: CardFeeConfig, installments: number): CardFeeBand {
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_CARD_INSTALLMENTS) {
    throw new CardFeeError("installments_out_of_range");
  }
  const band = config.bands.find((b) => b.maxInstallments >= installments);
  if (!band) throw new CardFeeError("installments_out_of_range");
  return band;
}

// Total = (recarga + taxa fixa) / (1 - taxa%), arredondado para cima ao centavo. A taxa repassada é total - recarga.
// Parcelas iguais (piso); o resto vai na última. O saldo sobe pela recarga.
export function computeCardCharge(
  config: CardFeeConfig,
  input: { rechargeCents: number; installments: number },
): { totalCents: number; feeCents: number; installmentCents: number[] } {
  const { rechargeCents, installments } = input;
  if (!Number.isSafeInteger(rechargeCents) || rechargeCents < 1) throw new CardFeeError("invalid_amount");
  const band = bandFor(config, installments);

  const divisor = FULL - Math.round(band.percent * PERCENT_SCALE);
  const totalCents = Math.floor(((rechargeCents + band.fixedCents) * FULL + divisor - 1) / divisor);

  const regular = Math.floor(totalCents / installments);
  if (regular < config.minInstallmentCents) throw new CardFeeError("installment_below_minimum");
  const installmentCents = Array.from({ length: installments }, (_, i) =>
    i === installments - 1 ? totalCents - regular * (installments - 1) : regular,
  );
  return { totalCents, feeCents: totalCents - rechargeCents, installmentCents };
}

// Planos que a tela mostra. installmentCents é a parcela regular (a última pode ter alguns centavos a mais).
export function listInstallmentOptions(
  config: CardFeeConfig,
  rechargeCents: number,
): Array<{ installments: number; totalCents: number; installmentCents: number }> {
  const options: Array<{ installments: number; totalCents: number; installmentCents: number }> = [];
  for (let installments = 1; installments <= MAX_CARD_INSTALLMENTS; installments++) {
    try {
      const charge = computeCardCharge(config, { rechargeCents, installments });
      options.push({ installments, totalCents: charge.totalCents, installmentCents: charge.installmentCents[0] });
    } catch (error) {
      if (!(error instanceof CardFeeError)) throw error;
    }
  }
  return options;
}
