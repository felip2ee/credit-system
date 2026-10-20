import { describe, expect, it } from "vitest";
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
