import { formatCNPJ, formatCPF, onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

// Mostra só os dígitos do meio: CPF ***.456.789-** e CNPJ **.345.678/0001-**.
export function maskDocument(type: EntityKind, document: string): string {
  const digits = onlyDigits(document);
  if (type === "PJ") {
    return digits.length === 14 ? formatCNPJ(digits).replace(/^\d{2}|\d{2}$/g, "**") : "—";
  }
  return digits.length === 11 ? formatCPF(digits).replace(/^\d{3}|\d{2}$/g, "***") : "—";
}
