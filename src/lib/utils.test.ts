import { describe, expect, it } from "vitest";

import {
  formatCNPJ,
  formatCPF,
  formatCurrency,
  formatDate,
  formatDateTime,
  isValidCNPJ,
  isValidCPF,
  isValidEmail,
  onlyDigits,
} from "./utils";

// CPF/CNPJ válidos conhecidos (dígitos verificadores corretos).
const VALID_CPF = "11144477735";
const VALID_CNPJ = "11222333000181";

describe("onlyDigits", () => {
  it("remove tudo que não for dígito", () => {
    expect(onlyDigits("111.444.777-35")).toBe("11144477735");
    expect(onlyDigits("abc 123 !@#")).toBe("123");
    expect(onlyDigits("")).toBe("");
  });
});

describe("isValidCPF", () => {
  it("aceita CPF válido com e sem formatação", () => {
    expect(isValidCPF(VALID_CPF)).toBe(true);
    expect(isValidCPF("111.444.777-35")).toBe(true);
  });

  it("rejeita dígitos verificadores errados", () => {
    expect(isValidCPF("11144477700")).toBe(false);
    expect(isValidCPF("52998224724")).toBe(false);
  });

  it("rejeita tamanho incorreto", () => {
    expect(isValidCPF("123")).toBe(false);
    expect(isValidCPF("111444777350")).toBe(false);
  });

  it("rejeita sequência de dígitos repetidos", () => {
    expect(isValidCPF("00000000000")).toBe(false);
    expect(isValidCPF("11111111111")).toBe(false);
  });
});

describe("isValidCNPJ", () => {
  it("aceita CNPJ válido com e sem formatação", () => {
    expect(isValidCNPJ(VALID_CNPJ)).toBe(true);
    expect(isValidCNPJ("11.222.333/0001-81")).toBe(true);
  });

  it("rejeita dígitos verificadores errados", () => {
    expect(isValidCNPJ("11222333000180")).toBe(false);
  });

  it("rejeita tamanho incorreto e dígitos repetidos", () => {
    expect(isValidCNPJ("1122233300018")).toBe(false);
    expect(isValidCNPJ("00000000000000")).toBe(false);
  });
});

describe("formatCPF", () => {
  it("formata CPF completo", () => {
    expect(formatCPF("11144477735")).toBe("111.444.777-35");
  });

  it("formata parcialmente durante a digitação", () => {
    expect(formatCPF("111444")).toBe("111.444");
  });
});

describe("formatCNPJ", () => {
  it("formata CNPJ completo", () => {
    expect(formatCNPJ("11222333000181")).toBe("11.222.333/0001-81");
  });
});

describe("formatCurrency", () => {
  it("retorna travessão para null/undefined", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
  });

  it("formata em BRL", () => {
    const out = formatCurrency(1234.5);
    expect(out).toContain("R$");
    expect(out).toContain("1.234,50");
  });

  it("formata zero (não é tratado como vazio)", () => {
    expect(formatCurrency(0)).toContain("0,00");
  });
});

describe("formatDate / formatDateTime", () => {
  it("retorna travessão para valor ausente", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("formata uma data no padrão pt-BR", () => {
    expect(formatDate("2026-06-24T12:00:00Z")).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("formatDateTime inclui hora", () => {
    expect(formatDateTime("2026-06-24T12:00:00Z")).toMatch(/\d{2}:\d{2}/);
  });
});

describe("isValidEmail", () => {
  it("aceita e-mails válidos", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("  a@b.co  ")).toBe(true);
  });

  it("rejeita e-mails inválidos", () => {
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("ab.co")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
  });
});
