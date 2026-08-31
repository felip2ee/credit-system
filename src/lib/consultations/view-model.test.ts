import { describe, expect, it } from "vitest";

import { adapt } from "@/lib/deps/adapter";
import type { AdaptContext, CanonicalBureauResult } from "@/types/bureau";
import { toConsultationView, incompatibleView } from "./view-model";

import pfCurrent from "@/lib/deps/__fixtures__/pf-current.json";
import pjCurrent from "@/lib/deps/__fixtures__/pj-current.json";

const ctx: AdaptContext = {
  product: "Smart PF 002",
  httpStatus: 200,
  receivedAt: new Date("2026-08-31T00:00:00Z"),
};

function canonical(body: unknown): CanonicalBureauResult {
  const r = adapt(body, ctx);
  if (!r.ok) throw new Error(`fixture did not adapt: ${JSON.stringify(r.errors)}`);
  return r.value;
}

describe("toConsultationView", () => {
  it("PF fixture: subject, score and cents formatting", () => {
    const v = toConsultationView(canonical(pfCurrent));
    expect(v.incompatible).toBe(false);
    expect(v.kind).toBe("PF");
    expect(v.subject.documentLabel).toBe("CPF");
    // digits-only never surfaces formatted here — document is redacted-safe label only
    expect(v.subject.name).toBe("Fulano De Tal Anonimo");
    expect(v.score.value).toBe(742);
    expect(v.score.empty).toBe(false);
    // debts item 125050 cents -> R$ 1.250,50
    expect(v.debts.items[0].amount).toContain("1.250,50");
    expect(v.protests.items[0].amount).toContain("812,34");
  });

  it("PJ fixture: ownership present, participation empty", () => {
    const v = toConsultationView(canonical(pjCurrent));
    expect(v.kind).toBe("PJ");
    expect(v.ownership.empty).toBe(false);
    expect(v.ownership.items).toHaveLength(2);
    expect(v.participation.empty).toBe(true);
    expect(v.subject.capital).toContain("150.000,00");
  });

  it("missing optional sections render empty states", () => {
    const v = toConsultationView(
      canonical({ mix: { pessoa: { data: { cpf: "39053344705", nome: "So Nome" } } } }),
    );
    expect(v.score.empty).toBe(true);
    expect(v.score.value).toBeNull();
    expect(v.debts.empty).toBe(true);
    expect(v.debts.total).toBe(0);
    expect(v.debts.amount).toBe("—");
    expect(v.protests.empty).toBe(true);
    expect(v.lawsuits.empty).toBe(true);
    expect(v.checks.empty).toBe(true);
    expect(v.queries.empty).toBe(true);
    expect(v.ownership.empty).toBe(true);
    expect(v.participation.empty).toBe(true);
  });

  it("drops generic provider messages, keeps meaningful ones", () => {
    const v = toConsultationView(
      canonical({
        mix: {
          pessoa: { data: { cpf: "39053344705", nome: "Msg Test" } },
          protestos: { message: "Nada consta", data: null },
          score: { message: "ok", data: null },
        },
      }),
    );
    expect(v.messages).toContain("Nada consta");
    expect(v.messages).not.toContain("ok");
  });

  it("splits judicial actions out of debts", () => {
    const v = toConsultationView(
      canonical({
        mix: {
          pessoa: { data: { cpf: "39053344705", nome: "Split Test" } },
          pendenciasRestricoes: {
            data: { ocorrencias: [{ informante: "BANCO X", valor: 100, tipo: "Dívida" }] },
          },
          acoesJudiciais: {
            data: { ocorrencias: [{ acao: "Execução", valor: 200, comarca: "SP", uf: "SP" }] },
          },
        },
      }),
    );
    expect(v.debts.items).toHaveLength(1);
    expect(v.debts.items[0].source).toBe("BANCO X");
    expect(v.lawsuits.items).toHaveLength(1);
    expect(v.lawsuits.empty).toBe(false);
  });
});

describe("incompatibleView", () => {
  it("never dereferences a result and carries the consultation id", () => {
    const v = incompatibleView("abc-123");
    expect(v.incompatible).toBe(true);
    expect(v.consultationId).toBe("abc-123");
    expect(typeof v.message).toBe("string");
    expect(v.message.length).toBeGreaterThan(0);
    // @ts-expect-error — the incompatible view has no result fields to read
    expect(v.subject).toBeUndefined();
  });
});
