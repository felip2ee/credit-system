import { describe, expect, it } from "vitest";

import { registerFormSchema, registerSchema } from "./register";

const VALID_CPF = "529.982.247-25";
const VALID_CNPJ = "11.222.333/0001-81";

const base = {
  slug: "reino",
  type: "PF" as const,
  name: "Maria da Silva",
  document: VALID_CPF,
  email: "maria@example.com",
  phone: "(63) 99234-5615",
  password: "uma-senha-longa-12",
  confirm: "uma-senha-longa-12",
  acceptedTerms: true,
  termsVersion: 1,
  privacyVersion: 1,
};

function documentIssue(overrides: Record<string, unknown>) {
  const result = registerFormSchema.safeParse({ ...base, ...overrides });
  return result.success ? null : result.error.issues;
}

describe("registerFormSchema", () => {
  it("accepts a PF with a valid CPF and registerSchema returns unmasked digits", () => {
    const parsed = registerSchema.parse(base);
    expect(parsed.documentDigits).toBe("52998224725");
  });

  it("accepts a PJ with a valid CNPJ", () => {
    expect(registerSchema.parse({ ...base, type: "PJ", name: "Reino Ltda", document: VALID_CNPJ }).documentDigits).toBe(
      "11222333000181",
    );
  });

  it.each([
    ["a CPF with a wrong digit", { document: "529.982.247-24" }, "CPF inválido."],
    ["a CNPJ with a wrong digit", { type: "PJ", name: "Reino Ltda", document: "11.222.333/0001-80" }, "CNPJ inválido."],
    ["a PF with a CNPJ", { document: VALID_CNPJ }, "CPF inválido."],
    ["a PJ with a CPF", { type: "PJ", name: "Reino Ltda", document: VALID_CPF }, "CNPJ inválido."],
  ])("rejects %s on the document field", (_name, overrides, message) => {
    const issues = documentIssue(overrides);
    expect(issues?.find((i) => i.path[0] === "document")?.message).toBe(message);
  });

  it("requires the full name for PF and the company name for PJ", () => {
    expect(documentIssue({ name: "Ma" })?.find((i) => i.path[0] === "name")?.message).toBe("Informe o nome completo.");
    expect(
      documentIssue({ type: "PJ", document: VALID_CNPJ, name: "R" })?.find((i) => i.path[0] === "name")?.message,
    ).toBe("Informe a razão social.");
  });

  it("flags different passwords on confirm", () => {
    const issue = documentIssue({ confirm: "outra-senha-longa" })?.find((i) => i.path[0] === "confirm");
    expect(issue?.message).toBe("As senhas não coincidem.");
  });

  it("requires accepted terms", () => {
    expect(documentIssue({ acceptedTerms: false })?.[0].message).toBe(
      "Aceite os termos de uso e a política de privacidade.",
    );
  });

  it("lowercases the e-mail", () => {
    expect(registerSchema.parse({ ...base, email: "  MARIA@Example.COM " }).email).toBe("maria@example.com");
  });

  it("rejects a slug with path characters", () => {
    expect(documentIssue({ slug: "../x" })?.[0].message).toBe("Bureau inválido.");
  });

  it("rejects an 11-character password", () => {
    const short = "a".repeat(11);
    expect(documentIssue({ password: short, confirm: short })?.some((i) => i.path[0] === "password")).toBe(true);
  });
});
