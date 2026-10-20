import { describe, expect, it } from "vitest";
import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { formatScalar, toGenericBlock, toGenericValue } from "./generic-block";
import { labelFor } from "./labels";

describe("labelFor", () => {
  it.each([
    ["rendaPresumida", "Renda presumida"],
    ["scr", "SCR"],
    ["cpf", "CPF"],
    ["uf", "UF"],
    ["vencimentoPorModalidades", "Vencimento por modalidades"],
  ])("%s → %s", (key, label) => expect(labelFor(key)).toBe(label));
});

const FIXTURE_LABELS: [string, string][] = [
  ["depsIa", "DEPS IA"],
  ["nomeMae", "Nome da mãe"],
  ["obito", "Óbito"],
  ["situacaoCadastral", "Situação cadastral"],
  ["participacaoEmpresa", "Participação em empresa"],
  ["vinculoEmpregaticio", "Vínculo empregatício"],
  ["falenciasRecuperacaoJudicial", "Falências e recuperação judicial"],
  ["analiseRisco", "Análise de risco"],
  ["classificacao", "Classificação"],
  ["pontuacao", "Pontuação"],
  ["metrica", "Métrica"],
  ["endereco", "Endereço"],
  ["numero", "Número"],
  ["municipio", "Município"],
  ["historicoClassificacao", "Histórico de classificação"],
  ["todasClassificacoes", "Todas as classificações"],
  ["dataNascimento", "Data de nascimento"],
  ["dataInscricao", "Data de inscrição"],
  ["certidaoNegativaDebitos", "Certidão negativa de débitos"],
  ["quadroSocietario", "Quadro societário"],
  ["politica", "Política"],
  ["limiteMaximo", "Limite máximo"],
  ["ticketMedio", "Ticket médio"],
  ["procon", "PROCON"],
  ["whatsapp", "WhatsApp"],
];

function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, into));
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      allKeys(item, into);
    }
  }
  return into;
}

describe("labelFor on the fixture keys", () => {
  it.each(FIXTURE_LABELS)("%s → %s", (key, label) => expect(labelFor(key)).toBe(label));
  it("never produces a known unaccented label", () => {
    const bad = /\b(participacao|vinculo|falencias|analise|situacao|obito|classificacao|classificacoes|pontuacao|metrica|endereco|numero|municipio|politica|codigo|certidao|debitos|relacao|formula|obrigatorio|inscricao|maximo|minimo|medio|mae|historico|versao|usuario|informacao)\b/i;
    const labels = Array.from(allKeys(fixture)).map(labelFor).filter((label) => bad.test(label));
    expect(labels).toEqual([]);
  });
});

describe("formatScalar", () => {
  it.each([
    ["valorTotal", 1234.5, formatCurrency(1234.5)],
    ["limiteSugerido", 5000, formatCurrency(5000)],
    ["pontuacaoAtingida", 1234.5, "1.234,5"],
    ["possuiGastoEstimado", true, "Sim"],
    ["obito", false, "Não"],
    ["motivos", null, "—"],
    ["percentual", "10,22%", "10,22%"],
    ["dataNascimento", "1980-01-01T00:00:00", "01/01/1980"],
    ["dataNascimento", "1980-01-01T00:00:00-03:00", "01/01/1980"],
    ["ano", 2026, "2026"],
    ["numero", 1234, "1234"],
    ["cep", 1310000, "1310000"],
    ["codigo", 12345, "12345"],
    ["id", 9876, "9876"],
    ["total", 1234, formatCurrency(1234)],
    ["dataConsulta", "2026-10-19", "19/10/2026"],
    ["dataHora", "2026-10-19T14:30:00", "19/10/2026 14:30"],
    ["dataHoraReceita", "2026-10-19T17:30:00Z", formatDateTime("2026-10-19T17:30:00Z")],
    ["cpf", "52998224725", "***.982.247-**"],
    ["cpf", 52998224725, "***.982.247-**"],
    ["cnpj", "11222333000181", "**.222.333/0001-**"],
    ["documento", "123", "—"],
  ])("formatScalar(%s, %j) is %s", (key, value, expected) => expect(formatScalar(key, value)).toBe(expected));
});

describe("toGenericValue", () => {
  it("keeps the info of a nested envelope as a Nota field", () => {
    const v = toGenericValue({ restricoesCheques: { success: true, message: null, data: { a: 1 }, info: "nota" } });
    expect(v).toEqual({
      kind: "fields",
      fields: [
        {
          key: "restricoesCheques",
          label: "Restrições de cheques",
          value: {
            kind: "fields",
            fields: [
              { key: "a", label: "A", value: { kind: "text", text: "1" } },
              { key: "info", label: "Nota", value: { kind: "text", text: "nota" } },
            ],
          },
        },
      ],
    });
  });
  it("wraps non-record data of a nested envelope with info", () => {
    const v = toGenericValue({ x: { success: true, message: null, data: [{ a: 1 }], info: "n" } });
    expect(JSON.stringify(v)).toContain('"label":"Nota"');
  });
  it("masks document-like keys (cpfCnpj, documentoSocio, cnpjEmpresa) at any depth", () => {
    const value = { socios: [{ cpfCnpj: "52998224725", documentoSocio: "52998224725", cnpjEmpresa: "11222333000181" }] };
    const text = JSON.stringify(toGenericValue(value));
    expect(text).not.toContain("52998224725");
    expect(text).not.toContain("11222333000181");
    expect(JSON.stringify(toGenericValue({ a: { b: { c: { d: { e: value } } } } }))).not.toContain("52998224725");
  });
  it("unwraps an envelope and keeps info as note", () => {
    const block = toGenericBlock("modNovo", { success: true, message: null, data: { a: 1 }, info: "nota" });
    expect(block).toEqual({
      key: "modNovo",
      title: "Mod novo",
      note: "nota",
      value: { kind: "fields", fields: [{ key: "a", label: "A", value: { kind: "text", text: "1" } }] },
    });
  });
  it("shows the message of an envelope without data", () => {
    expect(toGenericValue({ success: true, message: "Nada consta.", data: null })).toEqual({
      kind: "text",
      text: "Nada consta.",
    });
  });
  it("turns an array of objects into a table with the union of keys", () => {
    expect(toGenericValue([{ a: 1 }, { b: 2, a: 3 }])).toEqual({
      kind: "table",
      columns: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      rows: [
        ["1", "—"],
        ["3", "2"],
      ],
    });
  });
  it("masks a document column inside a table", () => {
    const v = toGenericValue([{ documento: "52998224725", nome: "X" }]);
    expect(v).toMatchObject({ kind: "table", rows: [["***.982.247-**", "X"]] });
  });
  it("joins primitives and says Nenhum for an empty array", () => {
    expect(toGenericValue(["a", "b"])).toEqual({ kind: "text", text: "a, b" });
    expect(toGenericValue([])).toEqual({ kind: "text", text: "Nenhum" });
  });
  it("falls back to masked JSON beyond depth 4", () => {
    const deep = { n1: { n2: { n3: { n4: { n5: { cpf: "52998224725" } } } } } };
    const text = JSON.stringify(toGenericValue(deep));
    expect(text).toContain('"kind":"json"');
    expect(text).not.toContain("52998224725");
  });
  it("masks a nested cpf at any depth", () => {
    expect(JSON.stringify(toGenericValue({ a: { b: { cpf: "52998224725" } } }))).not.toContain("52998224725");
  });
  it("masks a document inside a table cell that holds an object", () => {
    const text = JSON.stringify(toGenericValue([{ a: { cpf: "52998224725" } }]));
    expect(text).not.toContain("52998224725");
  });
  it("uses masked JSON for mixed arrays", () => {
    const v = toGenericValue([{ cpf: "52998224725" }, "x"]);
    expect(v.kind).toBe("json");
    expect(JSON.stringify(v)).not.toContain("52998224725");
  });
});
