import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/actions/affiliate-withdrawals", () => ({ convertCommissionAction: vi.fn() }));

import { UseCommissionCard } from "./use-commission-card";

const render = (method: "pix" | "asaas", available: string) =>
  renderToStaticMarkup(createElement(UseCommissionCard, { method, available, fee: null }));

describe("UseCommissionCard", () => {
  it("modo Pix com saldo: mostra o cartão", () => {
    expect(render("pix", "7.00")).toContain("Usar a comissão");
  });

  it("modo Asaas: esconde o cartão mesmo com saldo na carteira", () => {
    expect(render("asaas", "7.00")).not.toContain("Usar a comissão");
  });

  it("modo Pix sem saldo: esconde o cartão", () => {
    expect(render("pix", "0.00")).not.toContain("Usar a comissão");
  });
});
