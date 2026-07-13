import { z } from "zod";

// Schema do formulário de detalhes do crédito (edição da oportunidade).
// Campos numéricos chegam como string do <input>; convertemos no transform.
// Strings vazias viram null para não sobrescrever com "".

const moneyToNumber = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (!v) return null;
    // aceita "1.234,56" (pt-BR) ou "1234.56"
    const normalized = v.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) && normalized.length > 0 ? n : null;
  });

const nullableString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

export const opportunityDetailsSchema = z.object({
  credit_product_id: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  cnpj: nullableString,
  credit_purpose: nullableString,
  requested_amount: moneyToNumber,
  monthly_revenue: moneyToNumber,
  responsible_name: nullableString,
  responsible_email: nullableString,
  responsible_phone: nullableString,
  responsible_cpf: nullableString,
  responsible_birth_date: nullableString,
  responsible_mother_name: nullableString,
  address: nullableString,
  address_number: nullableString,
  address_complement: nullableString,
  neighborhood: nullableString,
  city: nullableString,
  state: nullableString,
  zip_code: nullableString,
  partner_name: nullableString,
  partner_notes: nullableString,
  notes: nullableString,
});

export type OpportunityDetailsInput = z.infer<typeof opportunityDetailsSchema>;

// Valores brutos do formulário (antes do transform) — para o react-hook-form.
export const opportunityDetailsFormSchema = z.object({
  credit_product_id: z.string().trim(),
  cnpj: z.string().trim(),
  credit_purpose: z.string().trim(),
  requested_amount: z.string().trim(),
  monthly_revenue: z.string().trim(),
  responsible_name: z.string().trim(),
  responsible_email: z
    .string()
    .trim()
    .email("E-mail inválido.")
    .or(z.literal("")),
  responsible_phone: z.string().trim(),
  responsible_cpf: z.string().trim(),
  responsible_birth_date: z.string().trim(),
  responsible_mother_name: z.string().trim(),
  address: z.string().trim(),
  address_number: z.string().trim(),
  address_complement: z.string().trim(),
  neighborhood: z.string().trim(),
  city: z.string().trim(),
  state: z.string().trim().max(2, "UF com 2 letras."),
  zip_code: z.string().trim(),
  partner_name: z.string().trim(),
  partner_notes: z.string().trim(),
  notes: z.string().trim(),
});

export type OpportunityDetailsFormValues = z.infer<
  typeof opportunityDetailsFormSchema
>;
