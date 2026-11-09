import { describe, expect, it } from "vitest";

import { pixQrNote, pixSubmitLabel, pixSummaryFor, pixSummaryLine, unavailableMessage } from "./checkout-summary";

const nbsp = (s: string) => s.replace(/ /g, " ");
const charge = { rechargeCents: 10000, feeCents: 199, totalCents: 10199 };

describe("checkout-summary", () => {
  it("monta linha e botão com taxa", () => {
    expect(nbsp(pixSummaryLine(charge))).toBe("Recarga R$ 100,00 + taxa do Pix R$ 1,99 = você paga R$ 101,99");
    expect(nbsp(pixSubmitLabel(charge))).toBe("Pagar R$ 101,99 com Pix");
  });
  it("sem taxa ou valor velho: sem resumo, botão antigo", () => {
    expect(pixSummaryFor({ ...charge, feeCents: 0, totalCents: 10000 }, 10000)).toBeNull();
    expect(pixSummaryFor(charge, 5000)).toBeNull();
    expect(pixSummaryFor(null, 5000)).toBeNull();
    expect(pixSubmitLabel(null)).toBe("Gerar PIX");
    expect(pixSummaryFor(charge, 10000)).toBe(charge);
  });
  it("nota do QR", () => {
    expect(nbsp(pixQrNote(charge) ?? "")).toBe("Inclui taxa do Pix de R$ 1,99; seu saldo recebe R$ 100,00.");
    expect(pixQrNote(undefined)).toBeNull();
    expect(pixQrNote({ ...charge, feeCents: 0 })).toBeNull();
  });
  it("indisponibilidade", () => {
    expect(unavailableMessage(true, false)).toBeNull();
    expect(unavailableMessage(false, true)).toContain("Tente o cartão");
    expect(unavailableMessage(false, false)).toContain("Pagamento indisponível");
  });
});
