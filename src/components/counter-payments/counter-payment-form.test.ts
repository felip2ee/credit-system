import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OrderState } from "@/lib/orders/types";

import { blockImplicitSubmit, CounterPaymentForm } from "./CounterPaymentForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/actions/counter-payments", () => ({ registerCounterPaymentAction: vi.fn() }));

const render = (orderState: OrderState | null) =>
  renderToStaticMarkup(
    createElement(CounterPaymentForm, { dossierId: "d", holderName: "Maria", remainingCents: 10000, orderState }),
  );

describe("CounterPaymentForm", () => {
  it("pedido aguardando pagamento mostra o formulário e quanto falta", () => {
    const html = render("awaiting_payment");
    expect(html).toContain("<form");
    expect(html).toContain("Falta receber");
  });

  it("em qualquer outra situação não há formulário", () => {
    for (const state of ["awaiting_authorization", "ready", "completed", "cancelled", null] as const) {
      const html = render(state);
      expect(html).toContain("Este pedido não aguarda pagamento.");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("Falta receber");
    }
  });
});

describe("blockImplicitSubmit", () => {
  const press = (key: string, tagName: string) => {
    const preventDefault = vi.fn();
    blockImplicitSubmit({ key, target: { tagName } as unknown as EventTarget, preventDefault });
    return preventDefault.mock.calls.length;
  };

  it("Enter num campo não envia o pagamento", () => {
    expect(press("Enter", "INPUT")).toBe(1);
  });

  it("Enter no botão e outras teclas seguem normais", () => {
    expect(press("Enter", "BUTTON")).toBe(0);
    expect(press("a", "INPUT")).toBe(0);
  });
});
