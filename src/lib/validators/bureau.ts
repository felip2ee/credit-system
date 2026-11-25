import { z } from "zod";

import { optionalPasswordSchema } from "./password";
import { SLUG_PATTERN } from "./register";

const name = z
  .string()
  .trim()
  .min(1, "Informe o nome do Bureau.")
  .max(120, "Nome com no máximo 120 caracteres.");

export const bureauCreateSchema = z.object({
  name,
  slug: z
    .string()
    .regex(/^[a-z0-9-]{3,40}$/, "Use de 3 a 40 letras minúsculas, números ou hífen."),
  adminName: z.string().trim().min(3, "Informe o nome completo do administrador."),
  adminEmail: z.string().trim().toLowerCase().email("E-mail inválido."),
  adminPassword: optionalPasswordSchema,
});

export const bureauUpdateSchema = z.object({
  id: z.string().uuid(),
  name,
  // Ausente = não troca o slug.
  slug: z.string().regex(SLUG_PATTERN, "Use de 3 a 40 letras minúsculas, números ou hífen.").optional(),
});

export type BureauCreate = z.infer<typeof bureauCreateSchema>;
export type BureauUpdate = z.infer<typeof bureauUpdateSchema>;
