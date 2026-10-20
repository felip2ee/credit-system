import { describe, expect, it } from "vitest";

import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import { DEPS_PRODUCT_PF } from "@/lib/deps/products";
import type { AdaptContext, CanonicalBureauResult } from "@/types/bureau";
import { toConsultationContent, toFullConsultationView } from "./full-view";

const ctx: AdaptContext = {
  product: DEPS_PRODUCT_PF,
  httpStatus: 200,
  receivedAt: new Date("2026-10-19T00:00:00Z"),
};

function canonical(body: unknown): CanonicalBureauResult {
  const r = adapt(body, ctx);
  if (!r.ok) throw new Error(`fixture did not adapt: ${JSON.stringify(r.errors)}`);
  return r.value;
}

// Payload mutável para os casos que alteram o mix (a fixture importada é compartilhada).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cloneFixture = (): any => structuredClone(fixture);

describe("toFullConsultationView", () => {
  it("orders the typed sections like spec §3.2", () => {
    const v = toFullConsultationView(fixture)!;
    expect(v.sections.map((s) => s.title)).toEqual([
      "Score",
      "Parecer Smart",
      "SCR (Banco Central)",
      "Renda presumida",
      "Restrições",
      "Pessoa",
      "Contatos e endereços",
      "Consultas",
    ]);
    expect(v.scoreValue).toBe(fixture.mix.score.data.score);
  });

  it("gives every mix key a destination", () => {
    const v = toFullConsultationView(fixture)!;
    const dest = new Set([
      ...v.sections.flatMap((s) => s.sources),
      ...v.generic.map((g) => g.key),
      ...v.missing.map((m) => m.key),
      ...v.meta.map((f) => f.key),
    ]);
    expect(Object.keys(fixture.mix).filter((k) => !dest.has(k))).toEqual([]);
    expect(dest.has("consultasComplementares")).toBe(true);
  });

  it("lists null modules as missing and keeps footer keys out of it", () => {
    const keys = toFullConsultationView(fixture)!.missing.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(["balanco", "empresa", "quadroSocietario", "participacaoEmpresa", "depsIa"]));
    expect(keys).not.toContain("centroCusto"); // rodapé
    expect(keys).not.toContain("protestos"); // consumido por Restrições
  });

  it("fills the Smart card with collapsed history parts", () => {
    const smart = toFullConsultationView(fixture)!.sections.find((s) => s.id === "smart")!;
    const titles = smart.parts.map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Parecer",
        "Resultado do parecer",
        "Classificação",
        "Métricas positivas",
        "Métricas negativas",
        "Todas as classificações",
        "Histórico de classificação",
      ]),
    );
    expect(smart.parts.filter((p) => p.collapsed).map((p) => p.title)).toEqual([
      "Todas as classificações",
      "Histórico de classificação",
    ]);
  });

  it("fills the SCR card with the seven totals and the groups", () => {
    const scr = toFullConsultationView(fixture)!.sections.find((s) => s.id === "scr")!;
    const totals = scr.parts.find((p) => p.title === "Totais")!.value;
    expect(totals.kind === "table" && totals.rows.length).toBe(7);
    expect(scr.parts.map((p) => p.title)).toEqual(
      expect.arrayContaining([
        "A vencer",
        "Vencidos",
        "Prejuízo",
        "Coobrigação",
        "Limite de crédito",
        "Crédito a liberar",
        "Repasse interfinanceiro",
        "Informações da consulta",
      ]),
    );
  });

  it("prefixes the detail rows of a modality", () => {
    const scr = toFullConsultationView(fixture)!.sections.find((s) => s.id === "scr")!;
    const loans = scr.parts.find((p) => p.title === "Empréstimos")!.value;
    expect(loans.kind === "table" && loans.rows.filter((r) => r[0]?.startsWith("  — ")).length).toBe(5);
  });

  it("shows restrictions with the deps message when there is no data", () => {
    const r = toFullConsultationView(fixture)!.sections.find((s) => s.id === "restricoes")!;
    expect(r.parts.find((p) => p.title === "Protestos")!.value).toEqual({ kind: "text", text: "Nada consta." });
  });

  it("never shows the full CPF", () => {
    expect(JSON.stringify(toFullConsultationView(fixture))).not.toContain("52998224725");
  });

  it("keeps unknown keys inside typed cards under Outros campos", () => {
    const c = cloneFixture();
    c.mix.scr.data.campoNovo = 123;
    c.mix.smart.data.parecer.campoNovo = "x";
    const v = toFullConsultationView(c)!;
    for (const id of ["scr", "smart"] as const) {
      expect(JSON.stringify(v.sections.find((s) => s.id === id)!.parts)).toContain("Campo novo");
    }
  });

  it("keeps row keys outside the named columns as extra columns in typed tables", () => {
    const c = cloneFixture();
    c.mix.smart.data.parecer.resultadoParecer[0].regras = ["r1"];
    c.mix.scr.data.vencimentoPorModalidade.carteiraAtiva.campoNovo = 5;
    const v = toFullConsultationView(c)!;
    const smart = JSON.stringify(v.sections.find((s) => s.id === "smart")!.parts);
    const scr = JSON.stringify(v.sections.find((s) => s.id === "scr")!.parts);
    expect(smart).toContain("r1");
    expect(scr).toContain("Campo novo");
    expect(scr).toContain('"5"');
  });

  it("shows the info of a typed module as a Nota part", () => {
    const c = cloneFixture();
    c.mix.score.info = "aviso do bureau";
    const score = toFullConsultationView(c)!.sections.find((s) => s.id === "score")!;
    expect(score.parts.at(-1)).toEqual({ title: "Nota", value: { kind: "text", text: "aviso do bureau" }, collapsed: false });
  });

  it("renders a new deps module through the generic block", () => {
    const c = cloneFixture();
    c.mix.modNovo = { success: true, message: null, data: { valorTotal: 10 }, info: null };
    expect(toFullConsultationView(c)!.generic.map((g) => g.key)).toEqual(["modNovo"]);
  });

  it("keeps a deps error message out of the missing list", () => {
    const c = cloneFixture();
    c.mix.balanco = { success: false, message: "Erro ao consultar o bloco", data: null, info: null };
    const v = toFullConsultationView(c)!;
    expect(v.missing.map((m) => m.key)).not.toContain("balanco");
    expect(v.generic.find((g) => g.key === "balanco")!.value).toEqual({ kind: "text", text: "Erro ao consultar o bloco" });
  });

  it("lists a null restriction module as missing instead of inventing Nada consta", () => {
    const c = cloneFixture();
    c.mix.protestos = null;
    const v = toFullConsultationView(c)!;
    expect(v.missing.map((m) => m.key)).toContain("protestos");
    expect(v.sections.find((s) => s.id === "restricoes")!.parts.map((p) => p.title)).not.toContain("Protestos");
  });

  it("falls back to the generic block when a typed module has an unexpected shape", () => {
    const c = cloneFixture();
    c.mix.consultas = { success: true, message: null, data: ["x"], info: null };
    const v = toFullConsultationView(c)!;
    expect(v.sections.map((s) => s.id)).not.toContain("consultas");
    expect(v.generic.map((g) => g.key)).toContain("consultas");
  });

  it("accepts [{mix}], {mix} and the bare mix", () => {
    expect(toFullConsultationView([fixture])!.sections).toHaveLength(8);
    expect(toFullConsultationView(fixture)!.sections).toHaveLength(8);
    expect(toFullConsultationView(fixture.mix)!.sections).toHaveLength(8);
  });

  it("returns null without a usable mix", () => {
    for (const payload of [null, "x", 1, {}, []]) expect(toFullConsultationView(payload)).toBeNull();
  });
});

describe("toConsultationContent", () => {
  it("uses the payload when it has a mix", () => {
    const c = toConsultationContent(fixture, canonical(fixture));
    expect(c.full).not.toBeNull();
    expect(c.view).not.toBeNull();
  });
  it("falls back to the canonical view for an empty payload", () => {
    const c = toConsultationContent({}, canonical(fixture));
    expect(c.full).toBeNull();
    expect(c.view?.subject.name).toBe("Maria Exemplo da Silva");
  });
  it("returns nothing when both are absent", () => {
    expect(toConsultationContent(null, null)).toEqual({ full: null, view: null });
  });
});
