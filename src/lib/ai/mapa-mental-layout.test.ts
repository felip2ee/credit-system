import { describe, expect, it } from "vitest";
import type { MapaMental } from "@/types/ai";
import { layoutMapaMental, type MapaNode } from "./mapa-mental-layout";

type No = MapaMental["ramos"][number]["nos"][number];
const no = (texto = "Regularizar pendência"): No => ({ texto, prazo: "30_dias", dono: "Cliente" });
const mapa = (nRamos: number, nNos: number, evitarFirst = false): MapaMental => ({
  centro: "Plano de crédito",
  ramos: Array.from({ length: nRamos }, (_, i) => ({
    titulo: `Ramo ${i}`,
    tipo: evitarFirst && i === 0 ? ("evitar" as const) : ("etapa" as const),
    nos: Array.from({ length: nNos }, () => no()),
  })),
});

const overlap = (a: MapaNode, b: MapaNode) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function expectSane(m: MapaMental, width: number) {
  const l = layoutMapaMental(m, { width });
  for (const n of l.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x + n.w).toBeLessThanOrEqual(width);
    expect(n.y + n.h).toBeLessThanOrEqual(l.height);
  }
  for (let i = 0; i < l.nodes.length; i++)
    for (let j = i + 1; j < l.nodes.length; j++) expect(overlap(l.nodes[i], l.nodes[j])).toBe(false);
  return l;
}

describe("layoutMapaMental", () => {
  it("1 ramo x 1 nó", () => {
    const l = expectSane(mapa(1, 1), 780);
    expect(l.nodes).toHaveLength(3);
    expect(l.edges).toHaveLength(2);
  });
  it("8 ramos x 6 nós", () => {
    const l = expectSane(mapa(8, 6), 780);
    expect(l.height).toBeGreaterThan(0);
    expect(l.nodes).toHaveLength(1 + 8 + 48);
  });
  it("bandTops: one band per row of ramos, ascending, inside the map", () => {
    const l = layoutMapaMental(mapa(8, 2), { width: 503 });
    expect(l.bandTops).toHaveLength(3);
    expect(l.bandTops[0]).toBe(0);
    expect([...l.bandTops].sort((a, b) => a - b)).toEqual(l.bandTops);
    expect(l.bandTops[2]).toBeLessThan(l.height);
  });
  it("width 320 keeps nodes inside", () => {
    expectSane(mapa(8, 6), 320);
  });
  it("long texto wraps and grows box", () => {
    const long = Array.from({ length: 20 }, (_, i) => `palavra${i}`).join(" ").slice(0, 140);
    const at = (texto: string) =>
      layoutMapaMental(
        {
          centro: "c",
          ramos: ["a", "b", "c", "d"].map((titulo) => ({ titulo, tipo: "etapa" as const, nos: [no(texto)] })),
        },
        { width: 780 },
      ).nodes[2];
    const short = at("curto");
    const n = at(long);
    expect(long).toHaveLength(140);
    expect(n.lines.length).toBeGreaterThan(1);
    expect(n.h).toBeGreaterThan(short.h);
  });
  it("evitar ramo is last with kind evitar", () => {
    const l = expectSane(mapa(3, 2, true), 780);
    const heads = l.nodes.filter((n) => n.id.startsWith("ramo-"));
    expect(heads[heads.length - 1].kind).toBe("evitar");
    expect(heads.slice(0, -1).every((h) => h.kind === "ramo")).toBe(true);
  });
  it("edges connect existing ids", () => {
    const l = layoutMapaMental(mapa(8, 3), { width: 320 });
    const ids = new Set(l.nodes.map((n) => n.id));
    for (const e of l.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
  it("does not mutate input", () => {
    const m = mapa(3, 2, true);
    const clone = structuredClone(m);
    layoutMapaMental(m, { width: 780 });
    expect(m).toEqual(clone);
  });
});
