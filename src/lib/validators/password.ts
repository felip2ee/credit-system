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

const INVALID_PASSWORD_MESSAGE = "Senha inválida.";

// Para fluxos imperativos (sem react-hook-form): primeira mensagem de erro ou null.
export function firstPasswordError(password: string, confirm: string): string | null {
  const check = newPasswordSchema.safeParse({ password, confirm });
  return check.success ? null : (check.error.issues[0]?.message ?? INVALID_PASSWORD_MESSAGE);
}

// Corpo de superRefine para senha opcional + confirmação: em branco = sem checagem de força.
// A confirmação é sempre comparada, como nos formulários originais.
export function refineOptionalNewPassword(
  ctx: z.RefinementCtx,
  { password, confirm, passwordPath }: { password: string; confirm: string; passwordPath: string },
): void {
  const strength = password ? passwordSchema.safeParse(password) : null;
  if (strength && !strength.success) {
    ctx.addIssue({
      code: "custom",
      message: strength.error.issues[0]?.message ?? INVALID_PASSWORD_MESSAGE,
      path: [passwordPath],
    });
  }
  if (password !== confirm) {
    ctx.addIssue({ code: "custom", message: "As senhas não coincidem.", path: ["confirm"] });
  }
}
