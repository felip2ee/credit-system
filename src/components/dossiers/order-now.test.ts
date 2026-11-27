import { describe, expect, it } from "vitest";

import { PAYMENT_WINDOW_DAYS, type OrderState, type OrderStateReason } from "@/lib/orders/types";

import { canReleaseOrder, orderNowText } from "./order-now";

const base = {
  mode: "counter",
  aiStatus: "done",
  reason: null,
  canWrite: true,
  canRegisterPayment: true,
  hasBuyer: true,
  hasPartners: false,
  revoked: false,
} as const;
const text = (state: OrderState, extra: Partial<Parameters<typeof orderNowText>[0]> = {}) =>
  orderNowText({ ...base, state, ...extra });

describe("orderNowText", () => {
  it("pagamento no balcão: manda registrar só para quem pode agir", () => {
    expect(text("awaiting_payment")).toMatch(/Registre o pagamento/);
    expect(text("awaiting_payment", { canRegisterPayment: false })).toMatch(/Quem tem acesso ao balcão/);
    expect(text("awaiting_payment", { canWrite: false })).not.toMatch(/Registre/);
    expect(text("awaiting_payment", { canWrite: false })).toMatch(/Quem tem acesso ao balcão/);
  });

  it("pagamento no balcão: avisa o prazo e que a autorização vem depois", () => {
    for (const canRegisterPayment of [true, false]) {
      const t = text("awaiting_payment", { canRegisterPayment });
      expect(t).toContain(`${PAYMENT_WINDOW_DAYS} dias`);
      expect(t).toMatch(/cancelado/);
      expect(t).toMatch(/depois do pagamento/);
    }
  });

  it("pagamento online: espera o cliente, sem pedir registro", () => {
    const t = text("awaiting_payment", { mode: "online" });
    expect(t).toMatch(/pagamento do cliente/);
    expect(t).not.toMatch(/Registre|balcão/);
  });

  it("autorização, fila e execução dizem o que esperar", () => {
    expect(text("awaiting_authorization")).toMatch(/titular autorizar/);
    expect(text("ready")).toBe("Na fila. A consulta começa em instantes ou na próxima tentativa agendada.");
    expect(text("executing")).toMatch(/em andamento/);
  });

  it("autorização com sócios cobra todas as pessoas", () => {
    expect(text("awaiting_authorization", { hasPartners: true })).toMatch(/titular e de todos os sócios/);
    expect(text("awaiting_authorization")).not.toMatch(/sócios/);
  });

  it("pedido concluído no balcão pede liberação", () => {
    expect(text("completed")).toMatch(/liberar o resultado ao cliente/);
    expect(text("completed", { aiStatus: "pending" })).toMatch(/parecer/);
  });

  it("pedido concluído online: o sistema libera sozinho", () => {
    for (const aiStatus of ["done", "failed"] as const) {
      expect(text("completed", { mode: "online", aiStatus })).toMatch(/sistema libera o resultado ao cliente automaticamente/);
    }
    expect(text("completed", { mode: "online", aiStatus: "pending" })).toMatch(/sistema libera o resultado ao cliente quando/);
  });

  it("pedido online revogado: não é liberado de novo", () => {
    const t = text("completed", { mode: "online", revoked: true });
    expect(t).toMatch(/revogada/);
    expect(t).toMatch(/não libera/);
    expect(t).not.toMatch(/automaticamente/);
  });

  it("pedido sem cliente: a equipe entrega o PDF", () => {
    expect(text("completed", { hasBuyer: false })).toBe(
      "A consulta terminou. Este pedido não tem cliente: entregue o PDF pela equipe.",
    );
    expect(text("completed", { hasBuyer: false, aiStatus: "pending" })).toMatch(/parecer ainda está sendo gerado/);
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

describe("canReleaseOrder", () => {
  const order = { state: "completed", mode: "counter", aiStatus: "done", hasBuyer: true } as const;

  it("libera só balcão concluído, com cliente e sem parecer pendente", () => {
    expect(canReleaseOrder(order)).toBe(true);
    expect(canReleaseOrder({ ...order, aiStatus: "failed" })).toBe(true);
    expect(canReleaseOrder({ ...order, hasBuyer: false })).toBe(false);
    expect(canReleaseOrder({ ...order, aiStatus: "pending" })).toBe(false);
    expect(canReleaseOrder({ ...order, mode: "online" })).toBe(false);
    expect(canReleaseOrder({ ...order, state: "released" })).toBe(false);
  });
});
