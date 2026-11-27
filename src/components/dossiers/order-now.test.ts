import { describe, expect, it } from "vitest";

import { orderNowText } from "./order-now";

const base = { mode: "counter", aiStatus: "done", canRegisterPayment: true } as const;

describe("orderNowText", () => {
  it("pagamento: manda registrar só para quem pode", () => {
    expect(orderNowText({ ...base, state: "awaiting_payment" })).toMatch(/Registre o pagamento/);
    expect(orderNowText({ ...base, state: "awaiting_payment", canRegisterPayment: false })).not.toMatch(/Registre/);
  });

  it("pedido concluído: balcão pede liberação; online só espera o Bureau", () => {
    expect(orderNowText({ ...base, state: "completed" })).toMatch(/liberar o resultado ao cliente/);
    expect(orderNowText({ ...base, state: "completed", aiStatus: "pending" })).toMatch(/parecer/);
    expect(orderNowText({ ...base, state: "completed", mode: "online" })).toMatch(/aguarda a liberação/);
  });

  it("estados finais dizem que não há o que fazer", () => {
    expect(orderNowText({ ...base, state: "released" })).toMatch(/Nada a fazer/);
    expect(orderNowText({ ...base, state: "cancelled" })).toMatch(/Nada a fazer/);
  });
});
