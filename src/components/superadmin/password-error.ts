import { newPasswordSchema } from "@/lib/validators/password";

export type PasswordErrorField = "password" | "confirm";

// Como `firstPasswordError`, mas diz também qual campo tem o erro, para ligar a mensagem a ele.
export function passwordFieldError(
  password: string,
  confirm: string,
): { field: PasswordErrorField; message: string } | null {
  const check = newPasswordSchema.safeParse({ password, confirm });
  if (check.success) return null;
  const issue = check.error.issues[0];
  return { field: issue?.path[0] === "confirm" ? "confirm" : "password", message: issue?.message ?? "Senha inválida." };
}
