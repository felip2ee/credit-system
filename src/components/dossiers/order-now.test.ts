import { describe, expect, it } from "vitest";

import type { OrderState, OrderStateReason } from "@/lib/orders/types";

import { orderNowText } from "./order-now";

const base = { mode: "counter", aiStatus: "done", reason: null, canWrite: true, canRegisterPayment: true } as const;
const text = (state: OrderState, extra: Partial<Parameters<typeof orderNowText>[0]> = {}) =>
  orderNowText({ ...base, state, ...extra });

describe("orderNowText", () => {
  it("pagamento no balcão: manda registrar só para quem pode agir", () => {
    expect(text("awaiting_payment")).toMatch(/Registre o pagamento/);
    expect(text("awaiting_payment", { canRegisterPayment: false })).toMatch(/Quem tem acesso ao balcão/);
    expect(text("awaiting_payment", { canWrite: false })).not.toMatch(/Registre/);
    expect(text("awaiting_payment", { canWrite: false })).toMatch(/Quem tem acesso ao balcão/);
  });

  it("pagamento online: espera o cliente, sem pedir registro", () => {
    const t = text("awaiting_payment", { mode: "online" });
    expect(t).toMatch(/pagamento do cliente/);
    expect(t).not.toMatch(/Registre|balcão/);
  });

  it("autorização, fila e execução dizem o que esperar", () => {
    expect(text("awaiting_authorization")).toMatch(/titular autorizar/);
    expect(text("ready")).toMatch(/começa em instantes/);
    expect(text("executing")).toMatch(/em andamento/);
  });

  it("pedido concluído: balcão pede liberação; online só espera o Bureau", () => {
    expect(text("completed")).toMatch(/liberar o resultado ao cliente/);
    expect(text("completed", { aiStatus: "pending" })).toMatch(/parecer/);
    expect(text("completed", { mode: "online" })).toMatch(/aguarda a liberação/);
  });

  it("falha por autorização diz que a consulta não começou", () => {
    for (const reason of ["scr_refused", "scr_expired"] as const) {
      const t = text("failed", { reason });
      expect(t).toMatch(/não chegou a começar/);
      expect(t).not.toMatch(/não terminou/);
    }
  });

  it("falha na consulta mostra o motivo; sem motivo, texto genérico", () => {
    const reasons: OrderStateReason[] = ["deps_no_data", "deps_incompatible", "deps_unavailable"];
    for (const reason of reasons) expect(text("failed", { reason })).toMatch(/^A consulta não terminou\. Motivo: .+\.$/);
    expect(text("failed")).toBe("A consulta não terminou.");
  });

  it("cancelado mostra o motivo quando existe", () => {
    expect(text("cancelled", { reason: "cancelled_by_staff" })).toBe("Pedido encerrado. Motivo: Cancelada pela equipe. Nada a fazer.");
    expect(text("cancelled")).toBe("Pedido encerrado. Nada a fazer.");
  });

  it("liberado: nada a fazer; estado desconhecido cai no suporte", () => {
    expect(text("released")).toMatch(/Nada a fazer/);
    expect(text("nope" as OrderState)).toMatch(/Fale com o suporte/);
  });
});
