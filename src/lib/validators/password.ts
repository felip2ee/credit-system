import { z } from "zod";

// Sem dependência de servidor: os formulários importam este arquivo.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `A senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);

// Campo em branco = "sem senha": o fluxo cai no convite por e-mail.
export const optionalPasswordSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  passwordSchema.optional(),
);

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((value) => value.password === value.confirm, {
    message: "As senhas não coincidem.",
    path: ["confirm"],
  });
