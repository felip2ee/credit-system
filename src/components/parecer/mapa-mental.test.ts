import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MapaMental } from "@/types/ai";
import { MapaMentalView } from "./mapa-mental";

const mapa: MapaMental = {
  centro: "Plano de crédito 2026",
  ramos: [
    { titulo: "Regularizar", tipo: "etapa", nos: [{ texto: "Quitar pendência", prazo: "30_dias", dono: "Cliente" }] },
    { titulo: "Linhas de crédito", tipo: "evitar", nos: [{ texto: "Cheque especial", prazo: "continuo", dono: "Cliente" }] },
  ],
};
const render = (m: unknown) => renderToStaticMarkup(createElement(MapaMentalView, { mapa: m }));

describe("MapaMentalView", () => {
  const html = render(mapa);
  it("renders svg and accessible nested list", () => {
    expect(html).toContain('<svg role="img"');
    expect(html).toContain("sr-only");
    expect(html).toContain("Quitar pendência. Prazo: 30 dias. Responsável: Cliente.");
    expect(html).toContain("Prazo: Contínuo");
  });
  it("labels the evitar ramo", () => {
    expect(html).toContain("Evitar: Linhas de crédito");
  });
  it("renders nothing for undefined or invalid", () => {
    expect(render(undefined)).toBe("");
    expect(render({ centro: "", ramos: [] })).toBe("");
  });
});
