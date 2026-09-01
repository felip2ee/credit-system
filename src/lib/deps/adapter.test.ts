import { describe, expect, it } from "vitest";

import { adapt } from "./adapter";
import type { AdaptContext } from "@/types/bureau";

import pfCurrent from "./__fixtures__/pf-current.json";
import pfLegacy from "./__fixtures__/pf-legacy.json";
import pjCurrent from "./__fixtures__/pj-current.json";
import pjLegacy from "./__fixtures__/pj-legacy.json";

const ctx: AdaptContext = {
  product: "Smart PF 002",
  httpStatus: 200,
  receivedAt: new Date("2026-08-31T00:00:00Z"),
};

const okValue = (body: unknown) => {
  const r = adapt(body, ctx);
  if (!r.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(r.errors)}`);
  expect(r.version).toBe(1);
  return r.value;
};

describe("adapt — fixtures", () => {
  it("pf-current (score `score`, wrapped smart, protest object, array envelope)", () => {
    const v = okValue(pfCurrent);
    expect(v.subject.kind).toBe("PF");
    expect(v.document).toEqual({ type: "cpf", value: "39053344705" });
    expect(v.subject.name).toBe("Fulano De Tal Anonimo");
    expect(v.score.value).toBe(742);
    expect(v.protests.total).toBe(1);
    expect(v.protests.items[0].amountCents).toBe(81234);
    expect(v.debts.items[0].amountCents).toBe(125050);
    expect(v.participation[0].document).toBe("11222333000181");
    expect(v.provider.receivedAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("pf-legacy (score `valor`, unwrapped smart, protest list)", () => {
    const v = okValue(pfLegacy);
    expect(v.subject.kind).toBe("PF");
    expect(v.document.value).toBe("52998224725");
    expect(v.score.value).toBe(615);
    expect(v.subject.isPoliticallyExposed).toBe(true);
    expect(v.protests.total).toBe(1);
    expect(v.debts.items).toHaveLength(3); // 2 pendências + 1 ação judicial
    expect(v.debts.items.some((d) => d.amountCents === 50000)).toBe(true); // "500,00" coerced
  });

  it("pj-current (wrapped quadroSocietario list, money string)", () => {
    const v = okValue(pjCurrent);
    expect(v.subject.kind).toBe("PJ");
    expect(v.document).toEqual({ type: "cnpj", value: "11444777000161" });
    expect(v.subject.capitalCents).toBe(15000000); // "150.000,00"
    expect(v.score.value).toBe(880);
    expect(v.score.paymentProbability).toBe(94); // "94" coerced
    expect(v.companyOwnership).toHaveLength(2);
    expect(v.companyOwnership[0].document).toBe("39053344705");
    expect(v.protests.total).toBe(0);
  });

  it("pj-legacy (score `valor`, flat quadroSocietario, protest list)", () => {
    const v = okValue(pjLegacy);
    expect(v.subject.kind).toBe("PJ");
    expect(v.document.value).toBe("40688134000180");
    expect(v.score.value).toBe(430);
    expect(v.companyOwnership).toHaveLength(1);
    expect(v.protests.total).toBe(2);
  });
});

describe("adapt — tolerant behavior", () => {
  it("ignores unknown additive fields (top-level and nested)", () => {
    const base = structuredClone(pjCurrent) as { mix: Record<string, unknown> };
    base.mix.brandNewTopLevel = { anything: "here" };
    (base.mix.empresa as { data: Record<string, unknown> }).data.brandNewNested = "SHOULD_NOT_LEAK";
    const v = okValue(base);
    expect(JSON.stringify(v)).not.toContain("brandNewTopLevel");
    expect(JSON.stringify(v)).not.toContain("brandNewNested");
    expect(JSON.stringify(v)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("missing optional sections → empty arrays / null, still ok", () => {
    const v = okValue({ mix: { pessoa: { data: { cpf: "39053344705", nome: "So Nome Anonimo" } } } });
    expect(v.debts).toEqual({ total: 0, amountCents: null, items: [] });
    expect(v.protests).toEqual({ total: 0, amountCents: null, items: [] });
    expect(v.companyOwnership).toEqual([]);
    expect(v.participation).toEqual([]);
    expect(v.queries.items).toEqual([]);
    expect(v.score.value).toBeNull();
  });

  it("coerces numeric strings", () => {
    const v = okValue({
      mix: {
        pessoa: { data: { cpf: "39053344705", nome: "Num Strings Anonimo" } },
        score: { data: { valor: "750", probabilidadePagamento: "70" } },
      },
    });
    expect(v.score.value).toBe(750);
    expect(v.score.paymentProbability).toBe(70);
  });

  it("tolerates null module data everywhere", () => {
    const v = okValue({
      mix: {
        pessoa: { data: { cpf: "39053344705", nome: "Null Data Anonimo" } },
        score: { data: null },
        pendenciasRestricoes: { data: null },
        acoesJudiciais: { data: null },
        protestos: { data: null },
        consultas: { data: null },
      },
    });
    expect(v.score.value).toBeNull();
    expect(v.debts.items).toEqual([]);
    expect(v.protests.items).toEqual([]);
  });

  it("reads a `{data}`-wrapped restricoesCheques module", () => {
    const v = okValue({
      mix: {
        pessoa: { data: { cpf: "39053344705", nome: "Wrapped Cheques Anonimo" } },
        restricoesCheques: {
          success: true,
          message: "ok",
          data: { possuiInformacao: true, devolvidosSemFundo: "3", sustados: 1 },
        },
      },
    });
    expect(v.checks.hasInfo).toBe(true);
    expect(v.checks.returnedNoFunds).toBe(3);
    expect(v.checks.stopped).toBe(1);
  });

  it("bounds score to 0..1000", () => {
    const v = okValue({
      mix: { pessoa: { data: { cpf: "39053344705", nome: "Bounded Anonimo" } }, score: { data: { valor: 999999 } } },
    });
    expect(v.score.value).toBe(1000);
  });
});

describe("adapt — fail closed", () => {
  const errText = (body: unknown, c = ctx) => {
    const r = adapt(body, c);
    if (r.ok) throw new Error("expected failure");
    expect(r.version).toBe(1);
    for (const e of r.errors) {
      expect(typeof e.path).toBe("string");
      expect(typeof e.code).toBe("string");
      expect(typeof e.message).toBe("string");
    }
    return { errors: r.errors, json: JSON.stringify(r.errors) };
  };

  it("wrong root type (string / number / empty array / null)", () => {
    for (const bad of ["nope", 42, [], null, true]) {
      const { errors } = errText(bad);
      expect(errors[0].path).toBe("");
      expect(errors[0].code).toBe("root_not_object");
    }
  });

  it("missing required subject identity", () => {
    const { errors } = errText({ mix: { score: { data: { valor: 700 } } } });
    expect(errors.some((e) => e.path === "subject.name")).toBe(true);
  });

  it("missing required document — no payload value in the error", () => {
    const { errors, json } = errText({
      mix: { pessoa: { data: { nome: "SENSITIVE SUBJECT NAME" } } },
    });
    expect(errors.some((e) => e.path === "document.value")).toBe(true);
    expect(json).not.toContain("SENSITIVE");
  });

  it("wrong-typed identity field — no payload value in the error", () => {
    const { json } = errText({
      mix: { pessoa: { data: { cpf: "39053344705", nome: 999777 } } },
    });
    expect(json).not.toContain("999777");
  });
});
