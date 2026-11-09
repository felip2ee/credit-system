import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

// Sem dependência de servidor: os formulários importam este arquivo.
// Nenhuma mensagem de erro leva o valor digitado (documento, número do cartão, CVV).

export const cpfCnpjSchema = z
  .string()
  .transform(onlyDigits)
  .superRefine((digits, ctx) => {
    if (digits.length === 11 && isValidCPF(digits)) return;
    if (digits.length === 14 && isValidCNPJ(digits)) return;
    ctx.addIssue({ code: "custom", message: "CPF ou CNPJ inválido." });
  });

export const postalCodeSchema = z
  .string()
  .transform(onlyDigits)
  .refine((digits) => digits.length === 8, "CEP inválido.");

export const addressNumberSchema = z
  .string()
  .trim()
  .min(1, "Informe o número.")
  .max(10, "Use no máximo 10 caracteres.")
  .regex(/^[0-9A-Za-zÀ-ÿ\s/.-]+$/, "Número inválido.")
  .transform((value) => (value.toUpperCase() === "S/N" ? "S/N" : value));

const E164 = /^\+[1-9]\d{7,14}$/;

// Todos opcionais: a matriz de campos (pergunta do pagador) decide o que cada fluxo exige.
export const payerFieldsSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome.").max(120, "Use no máximo 120 caracteres.").optional(),
  document: cpfCnpjSchema.optional(),
  email: z.string().trim().toLowerCase().max(254, "E-mail inválido.").email("E-mail inválido.").optional(),
  phone: z.string().trim().regex(E164, "Celular inválido.").optional(),
  postalCode: postalCodeSchema.optional(),
  addressNumber: addressNumberSchema.optional(),
});

export type PayerFields = z.infer<typeof payerFieldsSchema>;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Dados do cartão: só passam pela memória do servidor, nunca vão ao banco, ao log ou à auditoria.
export const cardFieldsSchema = z
  .object({
    number: z
      .string()
      .transform((value) => value.replace(/[\s-]/g, ""))
      .refine((digits) => /^\d{13,19}$/.test(digits) && passesLuhn(digits), "Número do cartão inválido."),
    holderName: z.string().trim().min(2, "Informe o nome impresso no cartão.").max(60, "Nome muito longo."),
    expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/, "Mês inválido."),
    expiryYear: z.string().regex(/^20\d{2}$/, "Ano inválido."),
    cvv: z.string().regex(/^\d{3,4}$/, "Código de segurança inválido."),
  })
  .superRefine((card, ctx) => {
    const now = new Date();
    const expired =
      Number(card.expiryYear) < now.getFullYear() ||
      (Number(card.expiryYear) === now.getFullYear() && Number(card.expiryMonth) < now.getMonth() + 1);
    if (expired) ctx.addIssue({ code: "custom", path: ["expiryYear"], message: "Cartão vencido." });
  });

export type CardFields = z.infer<typeof cardFieldsSchema>;
