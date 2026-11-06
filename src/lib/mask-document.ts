import { formatCNPJ, formatCPF, onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

// Mostra só os dígitos do meio: CPF ***.456.789-** e CNPJ **.345.678/0001-**.
export function maskDocument(type: EntityKind, document: string): string {
  const digits = onlyDigits(document);
  if (type === "PJ") {
    return digits.length === 14 ? formatCNPJ(digits).replace(/^\d{2}|\d{2}$/g, "**") : "—";
  }
  return digits.length === 11 ? formatCPF(digits).replace(/^\d{3}/, "***").replace(/\d{2}$/, "**") : "—";
}

// Valor bruto do payload (texto ou número). Nunca devolve o documento completo.
export function maskDocumentValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "—";
  const digits = onlyDigits(String(value));
  if (digits.length === 14) return maskDocument("PJ", digits);
  return maskDocument("PF", digits);
}

// Máscara do checkout de pagamento (mostra só o miolo). Entrada: só dígitos. Tamanho errado: "—".
// CPF ***.456.***-** e CNPJ **.345.***/****-**.
export function maskPayerDocument(digits: string): string {
  if (/^\d{11}$/.test(digits)) return `***.${digits.slice(3, 6)}.***-**`;
  if (/^\d{14}$/.test(digits)) return `**.${digits.slice(2, 5)}.***/****-**`;
  return "—";
}

// CEP *****-678.
export function maskPostalCode(digits: string): string {
  return /^\d{8}$/.test(digits) ? `*****-${digits.slice(5)}` : "—";
}

// Telefone E.164: (**) *****-4321. Só os 4 últimos dígitos aparecem.
export function maskPhone(e164: string): string {
  return /^\+\d{8,15}$/.test(e164) ? `(**) *****-${e164.slice(-4)}` : "—";
}
