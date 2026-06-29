import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

const baseFields = {
  email: z
    .string()
    .trim()
    .email("E-mail inválido.")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  phone: optionalString,
  address: optionalString,
  address_number: optionalString,
  address_complement: optionalString,
  neighborhood: optionalString,
  city: optionalString,
  state: optionalString,
  zip_code: optionalString,
  status: z.enum([
    "prospect",
    "active",
    "in_intermediation",
    "completed",
    "inactive",
  ]),
  notes: optionalString,
};

export const clientSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("PF"),
    name: z.string().trim().min(3, "Informe o nome completo."),
    document: z
      .string()
      .refine((v) => isValidCPF(v), "CPF inválido.")
      .transform(onlyDigits),
    ...baseFields,
  }),
  z.object({
    type: z.literal("PJ"),
    name: z.string().trim().min(2, "Informe a razão social."),
    document: z
      .string()
      .refine((v) => isValidCNPJ(v), "CNPJ inválido.")
      .transform(onlyDigits),
    ...baseFields,
  }),
]);

export type ClientInput = z.infer<typeof clientSchema>;

// Schema para o formulário (antes do transform) — usado pelo react-hook-form.
export const clientFormSchema = z.object({
  type: z.enum(["PF", "PJ"]),
  name: z.string().trim().min(2, "Campo obrigatório."),
  document: z.string().trim().min(1, "Documento obrigatório."),
  email: z.string().trim().email("E-mail inválido.").or(z.literal("")),
  phone: z.string().trim(),
  address: z.string().trim(),
  address_number: z.string().trim(),
  address_complement: z.string().trim(),
  neighborhood: z.string().trim(),
  city: z.string().trim(),
  state: z.string().trim().max(2, "UF com 2 letras."),
  zip_code: z.string().trim(),
  status: z.enum([
    "prospect",
    "active",
    "in_intermediation",
    "completed",
    "inactive",
  ]),
  notes: z.string().trim(),
});

export type ClientFormValues = z.infer<typeof clientFormSchema>;
