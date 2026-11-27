import { firstPasswordError, passwordSchema } from "@/lib/validators/password";

export type PasswordErrorField = "password" | "confirm";

// Soma ao `firstPasswordError` só o campo com o erro, para ligar a mensagem a ele.
export function passwordFieldError(
  password: string,
  confirm: string,
): { field: PasswordErrorField; message: string } | null {
  const message = firstPasswordError(password, confirm);
  if (!message) return null;
  return { field: passwordSchema.safeParse(password).success ? "confirm" : "password", message };
}
