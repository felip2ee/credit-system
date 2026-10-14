import { describe, expect, it } from "vitest";

import { canManagePayouts, cutoffFromDate, MAX_RECEIPT_BYTES, validateReceiptFile } from "./payout-logic";

describe("validateReceiptFile", () => {
  it("exige arquivo", () => {
    expect(validateReceiptFile(null)).toMatch(/Anexe/);
    expect(validateReceiptFile({ name: "a.pdf", size: 0 })).toMatch(/Anexe/);
  });
  it("recusa extensão fora de PDF, PNG e JPEG", () => {
    expect(validateReceiptFile({ name: "a.exe", size: 10 })).toMatch(/PDF, PNG ou JPEG/);
    expect(validateReceiptFile({ name: "semextensao", size: 10 })).toMatch(/PDF, PNG ou JPEG/);
  });
  it("recusa acima de 5 MB e aceita o limite exato", () => {
    expect(validateReceiptFile({ name: "a.PDF", size: MAX_RECEIPT_BYTES + 1 })).toMatch(/5 MB/);
    expect(validateReceiptFile({ name: "a.PDF", size: MAX_RECEIPT_BYTES })).toBeNull();
    expect(validateReceiptFile({ name: "a.jpeg", size: 100 })).toBeNull();
  });
});

describe("canManagePayouts", () => {
  const base = { role: "superadmin", canManage: true };
  it("mostra para superadmin com permissão", () => expect(canManagePayouts(base)).toBe(true));
  it("esconde em sessão de suporte", () => {
    expect(canManagePayouts({ ...base, supportSessionId: "s1" })).toBe(false);
    expect(canManagePayouts({ ...base, support: { bureauId: "b" } })).toBe(false);
  });
  it("esconde sem permissão ou para outro papel", () => {
    expect(canManagePayouts({ ...base, canManage: false })).toBe(false);
    expect(canManagePayouts({ ...base, role: "bureau_admin" })).toBe(false);
  });
});

describe("cutoffFromDate", () => {
  it("converte data válida em ISO", () => expect(cutoffFromDate("2026-10-14")).toMatch(/^2026-10-1[45]T/));
  it("recusa formato inválido", () => {
    expect(cutoffFromDate("")).toBeNull();
    expect(cutoffFromDate("14/10/2026")).toBeNull();
    expect(cutoffFromDate("2026-13-45")).toBeNull();
  });
});
