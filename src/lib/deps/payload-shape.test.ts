import { describe, expect, it } from "vitest";
import { isEnvelope, isMissingModule } from "./payload-shape";
import fixture from "./__fixtures__/smart-pf-002.json";

describe("isEnvelope", () => {
  it("accepts a deps module envelope", () => {
    expect(isEnvelope({ success: true, message: null, data: { a: 1 }, info: null })).toBe(true);
    expect(isEnvelope({ success: true, message: "Nada consta.", data: null })).toBe(true);
  });
  it("rejects objects with other keys or without success/data", () => {
    expect(isEnvelope({ success: true, data: 1, codigo: 2 })).toBe(false);
    expect(isEnvelope({ data: 1 })).toBe(false);
    expect(isEnvelope([])).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});

describe("isMissingModule", () => {
  it.each([
    [null, true],
    [{ success: true, message: "Sem informação.", data: null }, true],
    [{ success: true, message: "nada consta", data: null }, true],
    [{ success: true, message: null, data: null }, true],
    [{ success: false, message: "Erro ao consultar o bloco", data: null }, false],
    [{ success: true, message: null, data: { a: 1 } }, false],
  ])("isMissingModule(%j) is %s", (input, expected) => {
    expect(isMissingModule(input)).toBe(expected);
  });
});

describe("smart-pf-002 fixture", () => {
  it("holds only fake personal data", () => {
    const m = fixture.mix;
    expect(String(m.pessoa.data.cpf)).toBe("52998224725");
    expect(m.pessoa.data.nome).toBe("Maria Exemplo da Silva");
    expect(m.emails.data.every((e: string) => e.endsWith("@example.com"))).toBe(true);
    expect(m.contatosPreferenciais.data.every((c: { documento: unknown }) => c.documento == null || c.documento === "52998224725")).toBe(true);
    expect(m.usuario).toBe("usuario-teste");
    expect(m.consultante).toBe("Consultante Teste");
  });
});
