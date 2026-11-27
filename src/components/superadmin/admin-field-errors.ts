import { z } from "zod";

// Mesmas regras de `inviteSchema` e `credentialsSchema` em src/actions/bureaus.ts (nome com 3+ letras, e-mail válido).
const nameRule = z.string().trim().min(3, "Informe o nome completo.");
const emailRule = z.string().trim().email("E-mail inválido.");

export function adminNameError(name: string): string | null {
  const check = nameRule.safeParse(name);
  return check.success ? null : (check.error.issues[0]?.message ?? "Informe o nome completo.");
}

export function adminEmailError(email: string): string | null {
  const check = emailRule.safeParse(email);
  return check.success ? null : (check.error.issues[0]?.message ?? "E-mail inválido.");
}
