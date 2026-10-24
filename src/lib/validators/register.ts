import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import { passwordSchema } from "@/lib/validators/password";

// Sem dependência de servidor: o formulário importa este arquivo.
export const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;
export const REFERRAL_CODE_PATTERN = /^[a-z0-9]{8}$/;

export const registerFormSchema = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, "Bureau inválido."),
    type: z.enum(["PF", "PJ"]),
    name: z.string().trim().max(120, "Use no máximo 120 caracteres."),
    document: z.string().trim().min(1, "Documento obrigatório."),
    email: z.string().trim().toLowerCase().max(254).email("E-mail inválido."),
    phone: z.string().trim().min(10, "Informe o celular com DDD.").max(30, "Celular inválido."),
    password: passwordSchema,
    confirm: z.string(),
    // boolean + refine (não z.literal(true)): o formulário começa com false.
    acceptedTerms: z.boolean().refine((v) => v, "Aceite os termos de uso e a política de privacidade."),
    termsVersion: z.number().int().positive(),
    privacyVersion: z.number().int().positive(),
    // Código do link de afiliado (?ref=). Valor malformado vira undefined: o cadastro segue sem vínculo.
    referralCode: z
      .string()
      .optional()
      .transform((v) => (v && REFERRAL_CODE_PATTERN.test(v) ? v : undefined)),
  })
  .superRefine((v, ctx) => {
    // Mesma regra de holderSchema: PF = nome 3+ e CPF válido; PJ = razão social 2+ e CNPJ válido.
    const digits = onlyDigits(v.document);
    if (v.type === "PF") {
      if (v.name.length < 3) ctx.addIssue({ code: "custom", path: ["name"], message: "Informe o nome completo." });
      if (!isValidCPF(digits)) ctx.addIssue({ code: "custom", path: ["document"], message: "CPF inválido." });
    } else {
      if (v.name.length < 2) ctx.addIssue({ code: "custom", path: ["name"], message: "Informe a razão social." });
      if (!isValidCNPJ(digits)) ctx.addIssue({ code: "custom", path: ["document"], message: "CNPJ inválido." });
    }
    if (v.password !== v.confirm) {
      ctx.addIssue({ code: "custom", path: ["confirm"], message: "As senhas não coincidem." });
    }
  });

export type RegisterFormValues = z.input<typeof registerFormSchema>;
export const registerSchema = registerFormSchema.transform((v) => ({ ...v, documentDigits: onlyDigits(v.document) }));
export type RegisterInput = z.output<typeof registerSchema>;
