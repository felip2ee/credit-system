import { describe, expect, it } from "vitest";

import fixtureJson from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import type { Parecer } from "@/types/ai";

import { pruneForAi, withRemovedNote } from "./bureau-input";
import { COMPANY_PROMPT_VERSION, COMPANY_SYSTEM_PROMPT, PROMPT_VERSION, SYSTEM_PROMPT_PF, SYSTEM_PROMPT_PJ, buildCompanyPayload, buildUserPayload } from "./prompt";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fixture = fixtureJson as any;
const pad = (list: unknown[], n: number): unknown[] => Array.from({ length: n }, () => list[0]);
const adapted = adapt(fixtureJson, { product: "Smart PF 002", httpStatus: 200, receivedAt: "2026-10-19T00:00:00Z" });
if (!adapted.ok) throw new Error("fixture must adapt");
const canonical = adapted.value;

describe("pruneForAi", () => {
  it("unwraps envelopes and keeps the deps message of data-less modules", () => {
    const { bureau } = pruneForAi(fixture);
    expect(bureau!.score).toEqual(fixture.mix.score.data);
    expect(bureau!.protestos).toEqual({ message: "Nada consta." });
  });

  it("drops null modules and footer keys", () => {
    const b = pruneForAi(fixture).bureau!;
    expect(b).not.toHaveProperty("balanco");
    for (const k of ["versao", "produto", "dataConsulta", "consultante", "usuario", "historicoConsultaId", "isParcial", "isGrupo", "centroCusto", "blocosComErros", "linkCompartilhamento"]) {
      expect(b).not.toHaveProperty(k);
    }
  });

  it("drops contact and personal data that does not feed the opinion", () => {
    const b = pruneForAi(fixture).bureau!;
    for (const k of ["contatosPreferenciais", "emails", "outrosEnderecos"]) expect(b).not.toHaveProperty(k);
    for (const k of ["nomeMae", "dataNascimento", "dadosCadastrais", "identidade"]) expect(b.pessoa).not.toHaveProperty(k);
  });

  it("masks documents at any depth", () => {
    const { bureau } = pruneForAi(fixture);
    expect((bureau!.pessoa as Record<string, unknown>).cpf).toBe("***.982.247-**");
    expect(JSON.stringify(bureau)).not.toContain("52998224725");
  });

  it("drops PJ contact keys at any depth", () => {
    const c = structuredClone(fixture);
    c.mix.empresa = { success: true, message: null, info: null, data: { razaoSocial: "X", telefones: ["11999999999"], endereco: "Rua", cep: "01001000", cnpj: "11222333000181" } };
    expect(pruneForAi(c).bureau!.empresa).toEqual({ razaoSocial: "X", cnpj: "**.222.333/0001-**" });
  });

  it("does not mutate the input payload", () => {
    const before = JSON.stringify(fixture);
    pruneForAi(fixture);
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it("does not cut a payload under the limit", () => {
    expect(pruneForAi(fixture).removed).toEqual([]);
  });

  it("cuts history first, then all classifications, then detailed SCR items", () => {
    const c = structuredClone(fixture);
    c.mix.smart.data.historicoClassificacao = pad(c.mix.smart.data.historicoClassificacao, 400);
    let r = pruneForAi(c);
    expect(r.removed).toEqual(["smart.historicoClassificacao"]);
    expect((r.bureau!.smart as Record<string, unknown>).todasClassificacoes).toBeDefined();
    expect(JSON.stringify(r.bureau).length).toBeLessThanOrEqual(80_000);

    c.mix.smart.data.todasClassificacoes = pad(c.mix.smart.data.todasClassificacoes, 600);
    r = pruneForAi(c);
    expect(r.removed).toEqual(["smart.historicoClassificacao", "smart.todasClassificacoes"]);

    const mods = c.mix.scr.data.vencimentoPorModalidade.vencimentoPorModalidades;
    mods[0].itens[0].itensDetalhados = pad(mods[0].itens[0].itensDetalhados, 1500);
    r = pruneForAi(c);
    expect(r.removed).toEqual(["smart.historicoClassificacao", "smart.todasClassificacoes", "scr.vencimentoPorModalidade.vencimentoPorModalidades[].itens[].itensDetalhados"]);
    expect(JSON.stringify(r.bureau)).not.toContain("itensDetalhados");
  });

  it("returns no bureau for a missing or empty payload", () => {
    expect(pruneForAi(null)).toEqual({ bureau: null, removed: [] });
    expect(pruneForAi({})).toEqual({ bureau: null, removed: [] });
  });
});

describe("prompt builders", () => {
  it("adds bureau to the user payload only when present", () => {
    const input = { type: "PF" as const, dataAnalise: "2026-10-19", canonical };
    expect(JSON.parse(buildUserPayload(input, { score: { score: 1 } })).bureau).toEqual({ score: { score: 1 } });
    expect(JSON.parse(buildUserPayload(input))).not.toHaveProperty("bureau");
  });

  it("adds bureau to the company and each partner only when present", () => {
    const input = { dataAnalise: "2026-10-19", empresaRow: {}, socios: [{ type: "PF" as const, resultRow: {} }, { type: "PF" as const, resultRow: {} }] };
    const withBureaus = JSON.parse(buildCompanyPayload(input, { empresa: { a: 1 }, socios: [{ b: 2 }, null] }));
    expect(withBureaus.dados_empresa.bureau).toEqual({ a: 1 });
    expect(withBureaus.dados_socios[0].bureau).toEqual({ b: 2 });
    expect(withBureaus.dados_socios[1]).not.toHaveProperty("bureau");
    expect(JSON.parse(buildCompanyPayload(input)).dados_empresa).not.toHaveProperty("bureau");
  });

  it("records cut keys in dados_faltantes", () => {
    const parecer = { dados_faltantes: ["x"] } as unknown as Parecer;
    expect(withRemovedNote(parecer, [])).toBe(parecer);
    expect(withRemovedNote(parecer, ["smart.historicoClassificacao"]).dados_faltantes).toEqual(["x", "Dados retirados do input da IA por tamanho: smart.historicoClassificacao"]);
  });

  it("bumps the prompt versions and tells the model about bureau", () => {
    expect(PROMPT_VERSION).toBe("parecer-v2");
    expect(COMPANY_PROMPT_VERSION).toBe("parecer-empresa-v3");
    for (const p of [SYSTEM_PROMPT_PF, SYSTEM_PROMPT_PJ, COMPANY_SYSTEM_PROMPT]) expect(p).toContain("O campo `bureau` traz o retorno completo do bureau");
  });
});
