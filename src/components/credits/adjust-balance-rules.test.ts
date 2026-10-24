import { describe, expect, it } from "vitest";

import { canSubmitAdjustment } from "./adjust-balance-rules";

const base = { reason: "Correção de saldo", bureauAvailable: "150.00", clientAvailable: "100.00" };

describe("canSubmitAdjustment", () => {
  it("aceita crédito dentro do saldo do Bureau", () => {
    expect(canSubmitAdjustment({ ...base, direction: "credit", amount: "100,00" })).toEqual({ ok: true, message: null });
  });
  it("recusa crédito acima do saldo do Bureau", () => {
    const r = canSubmitAdjustment({ ...base, direction: "credit", amount: "100.00", bureauAvailable: "50.00" });
    expect(r).toEqual({ ok: false, message: "Saldo da carteira do Bureau insuficiente." });
  });
  it("aceita débito dentro do saldo do cliente", () => {
    expect(canSubmitAdjustment({ ...base, direction: "debit", amount: "30.00" }).ok).toBe(true);
  });
  it("recusa débito acima do saldo do cliente", () => {
    const r = canSubmitAdjustment({ ...base, direction: "debit", amount: "120.00" });
    expect(r).toEqual({ ok: false, message: "Saldo disponível do cliente insuficiente." });
  });
  it("recusa motivo curto, também só com espaços", () => {
    expect(canSubmitAdjustment({ ...base, direction: "credit", amount: "10", reason: "abc" }).ok).toBe(false);
    expect(canSubmitAdjustment({ ...base, direction: "credit", amount: "10", reason: "  ab   " }).ok).toBe(false);
  });
  it("recusa motivo acima de 500 caracteres", () => {
    expect(canSubmitAdjustment({ ...base, direction: "credit", amount: "10", reason: "a".repeat(501) }).ok).toBe(false);
  });
  it("recusa valor zero, vazio e acima do teto", () => {
    for (const amount of ["0", "", "100000000.00"]) {
      expect(canSubmitAdjustment({ ...base, direction: "credit", amount, bureauAvailable: "999999999.00" }).ok).toBe(false);
    }
  });
});
