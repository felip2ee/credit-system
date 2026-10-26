import { describe, expect, it } from "vitest";

import { STATE_TONE_ICON, stepperAnnouncement, toneRole, type StateTone } from "./state-tone";

describe("toneRole", () => {
  it("usa alert para atenção e erro", () => {
    expect(toneRole("danger")).toBe("alert");
    expect(toneRole("attention")).toBe("alert");
  });
  it("usa status para os demais tons", () => {
    for (const tone of ["success", "waiting", "progress", "neutral"] as StateTone[]) {
      expect(toneRole(tone)).toBe("status");
    }
  });
});

describe("STATE_TONE_ICON", () => {
  it("tem um ícone para cada um dos 6 tons", () => {
    expect(Object.keys(STATE_TONE_ICON).sort()).toEqual(
      ["attention", "danger", "neutral", "progress", "success", "waiting"],
    );
    for (const icon of Object.values(STATE_TONE_ICON)) expect(icon).toBeTruthy();
  });
});

describe("stepperAnnouncement", () => {
  it("anuncia o passo atual com 'Agora:'", () => {
    expect(
      stepperAnnouncement([
        { label: "Pedido feito", state: "done" },
        { label: "Consultando", state: "current" },
      ]),
    ).toBe("Agora: Consultando");
  });
  it("anuncia a falha quando não há passo atual", () => {
    expect(
      stepperAnnouncement([
        { label: "Pedido feito", state: "done" },
        { label: "Consultando", state: "failed" },
      ]),
    ).toBe("Falhou: Consultando");
  });
  it("devolve texto vazio quando nada está em andamento", () => {
    expect(stepperAnnouncement([{ label: "Pedido feito", state: "done" }])).toBe("");
  });
});
