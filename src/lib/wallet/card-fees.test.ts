import { describe, expect, it } from "vitest";

import type { CardFeeConfig } from "@/lib/config";

import { CardFeeError, computeCardCharge, listInstallmentOptions } from "./card-fees";

const config: CardFeeConfig = {
  bands: [
    { maxInstallments: 1, percent: 2.99, fixedCents: 49 },
    { maxInstallments: 6, percent: 3.49, fixedCents: 49 },
    { maxInstallments: 12, percent: 3.99, fixedCents: 49 },
  ],
  minInstallmentCents: 500,
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe("computeCardCharge", () => {
  // R$ 100,00 a 1x: (10000 + 49) / 0,9701 = 10358,7 -> 10359
  it("1x uses the first band and rounds the total up", () => {
    const result = computeCardCharge(config, { rechargeCents: 10000, installments: 1 });
    expect(result).toEqual({ totalCents: 10359, feeCents: 359, installmentCents: [10359] });
  });

  // (10000 + 49) / 0,9651 = 10412,4... -> 10413
  it("6x uses the second band; 7x moves to the third", () => {
    expect(computeCardCharge(config, { rechargeCents: 10000, installments: 6 }).totalCents).toBe(10413);
    // (10000 + 49) / 0,9601 = 10466,6... -> 10467
    expect(computeCardCharge(config, { rechargeCents: 10000, installments: 7 }).totalCents).toBe(10467);
  });

  it("12x uses the last band", () => {
    const result = computeCardCharge(config, { rechargeCents: 10000, installments: 12 });
    expect(result.totalCents).toBe(10467);
    expect(result.installmentCents).toHaveLength(12);
  });

  it("splits into equal installments with the remainder in the last", () => {
    const result = computeCardCharge(config, { rechargeCents: 10000, installments: 6 });
    // 10413 / 6 = 1735,5
    expect(result.installmentCents).toEqual([1735, 1735, 1735, 1735, 1735, 1738]);
  });

  it("keeps the exact result on a recurring decimal total", () => {
    // (3333 + 49) / 0,9701 = 3486,2... -> 3487
    expect(computeCardCharge(config, { rechargeCents: 3333, installments: 1 }).totalCents).toBe(3487);
  });

  it("does not round up when the division is exact", () => {
    const exact: CardFeeConfig = { bands: [{ maxInstallments: 12, percent: 50, fixedCents: 0 }], minInstallmentCents: 1 };
    expect(computeCardCharge(exact, { rechargeCents: 1000, installments: 1 }).totalCents).toBe(2000);
  });

  it.each([1, 2, 5, 6, 7, 11, 12])("total minus fee is the recharge and installments sum to the total (%ix)", (n) => {
    const free = { ...config, minInstallmentCents: 1 };
    for (const rechargeCents of [1000, 1234, 9999, 10000, 33333, 500000]) {
      const result = computeCardCharge(free, { rechargeCents, installments: n });
      expect(result.totalCents - result.feeCents).toBe(rechargeCents);
      expect(sum(result.installmentCents)).toBe(result.totalCents);
      expect(Number.isInteger(result.totalCents)).toBe(true);
      // O Asaas desconta percent% do total + taxa fixa: o líquido nunca fica abaixo da recarga.
      const band = config.bands.find((b) => b.maxInstallments >= n)!;
      const net = result.totalCents - (result.totalCents * band.percent) / 100 - band.fixedCents;
      expect(net).toBeGreaterThanOrEqual(rechargeCents - 1e-6);
    }
  });

  it("refuses 13x, 0x, fractions and NaN", () => {
    for (const installments of [13, 0, -1, 1.5, Number.NaN]) {
      expect(() => computeCardCharge(config, { rechargeCents: 10000, installments })).toThrow(CardFeeError);
    }
    try {
      computeCardCharge(config, { rechargeCents: 10000, installments: 13 });
    } catch (error) {
      expect((error as CardFeeError).code).toBe("installments_out_of_range");
    }
  });

  it("refuses installments beyond the last configured band", () => {
    const upTo6: CardFeeConfig = { bands: [{ maxInstallments: 6, percent: 3, fixedCents: 0 }], minInstallmentCents: 1 };
    expect(() => computeCardCharge(upTo6, { rechargeCents: 10000, installments: 7 })).toThrow(CardFeeError);
  });

  it("refuses an installment below the minimum", () => {
    // 1000 centavos em 12x dá cerca de 87 centavos por parcela.
    try {
      computeCardCharge(config, { rechargeCents: 1000, installments: 12 });
      expect.unreachable();
    } catch (error) {
      expect((error as CardFeeError).code).toBe("installment_below_minimum");
    }
  });

  it("refuses a recharge that is not a positive integer of cents", () => {
    for (const rechargeCents of [0, -5, 10.5, Number.NaN]) {
      expect(() => computeCardCharge(config, { rechargeCents, installments: 1 })).toThrow(CardFeeError);
    }
  });
});

describe("listInstallmentOptions", () => {
  it("lists every plan when all installments reach the minimum", () => {
    const options = listInstallmentOptions(config, 100000);
    expect(options.map((o) => o.installments)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(options[0]).toEqual({ installments: 1, totalCents: 103133, installmentCents: 103133 });
  });

  it("hides plans whose smallest installment is below the minimum", () => {
    // R$ 10,00: 1x 1082, 2x 543 por parcela, 3x 362 (< 500).
    const options = listInstallmentOptions(config, 1000);
    expect(options.map((o) => o.installments)).toEqual([1, 2]);
  });

  it("offers only what the table covers", () => {
    const upTo3: CardFeeConfig = { bands: [{ maxInstallments: 3, percent: 3, fixedCents: 0 }], minInstallmentCents: 1 };
    expect(listInstallmentOptions(upTo3, 10000).map((o) => o.installments)).toEqual([1, 2, 3]);
  });

  it("matches computeCardCharge, with the regular installment as the displayed value", () => {
    const options = listInstallmentOptions(config, 10000);
    const six = options.find((o) => o.installments === 6)!;
    const charge = computeCardCharge(config, { rechargeCents: 10000, installments: 6 });
    expect(six.totalCents).toBe(charge.totalCents);
    expect(six.installmentCents).toBe(charge.installmentCents[0]);
  });
});
