import { describe, expect, it } from "vitest";

import { formatCurrency } from "@/lib/utils";

import { counterSituation } from "./situation";

describe("counterSituation", () => {
  it("mostra quanto falta só quando o pedido aguarda pagamento", () => {
    expect(counterSituation(10000, "awaiting_payment")).toBe(`Falta ${formatCurrency(100)}`);
  });

  it("com saldo em outra situação diz que o pedido não aguarda pagamento", () => {
    for (const state of ["cancelled", "failed", "completed", null] as const) {
      expect(counterSituation(10000, state)).toBe("O pedido não aguarda pagamento");
    }
  });

  it("sem saldo está quitado; sem preço não há liquidação", () => {
    expect(counterSituation(0, "awaiting_authorization")).toBe("Quitado");
    expect(counterSituation(-1, "cancelled")).toBe("Quitado");
    expect(counterSituation(null, "awaiting_payment")).toBe("Sem liquidação ainda");
  });
});
