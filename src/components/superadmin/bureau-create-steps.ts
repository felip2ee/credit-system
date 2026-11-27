// Lógica pura da criação de Bureau em etapas: quais etapas existem e quando dá para sair de uma.
import { z } from "zod";

import { bureauCreateSchema } from "@/lib/validators/bureau";
import { refineOptionalNewPassword } from "@/lib/validators/password";

export type BureauStepId = "bureau" | "admin";

export interface BureauStep {
  id: BureauStepId;
  // Rótulo curto do cabeçalho ("Passo 1 de 2: Bureau").
  label: string;
  // Título da etapa (h2).
  title: string;
  // "O que acontece depois", em linguagem simples.
  after: string;
}

export const BUREAU_STEPS: BureauStep[] = [
  {
    id: "bureau",
    label: "Bureau",
    title: "Dados do Bureau",
    after: "Você informa quem será o primeiro administrador do Bureau.",
  },
  {
    id: "admin",
    label: "Administrador",
    title: "Primeiro administrador",
    after:
      "O Bureau é criado agora. Sem senha, o administrador recebe um convite por e-mail. Com senha, ele entra direto e troca a senha no primeiro acesso.",
  },
];

// Mesmo schema da action; a senha vem como texto (em branco = convite por e-mail) e ganha confirmação.
export const bureauCreateFormSchema = bureauCreateSchema
  .omit({ adminPassword: true })
  .extend({ adminPassword: z.string(), confirm: z.string() })
  .superRefine((v, ctx) =>
    refineOptionalNewPassword(ctx, {
      password: v.adminPassword,
      confirm: v.confirm,
      passwordPath: "adminPassword",
    }),
  );

export type BureauCreateValues = z.infer<typeof bureauCreateFormSchema>;
export type BureauField = keyof BureauCreateValues;

export const STEP_FIELDS: Record<BureauStepId, BureauField[]> = {
  bureau: ["name", "slug"],
  admin: ["adminName", "adminEmail", "adminPassword", "confirm"],
};

// Primeira mensagem de cada campo da etapa, na ordem dos campos.
export function stepErrors(step: BureauStepId, values: BureauCreateValues): Partial<Record<BureauField, string>> {
  const result = bureauCreateFormSchema.safeParse(values);
  if (result.success) return {};
  const found: Partial<Record<BureauField, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as BureauField;
    if (STEP_FIELDS[step].includes(field) && !found[field]) found[field] = issue.message;
  }
  return Object.fromEntries(STEP_FIELDS[step].filter((f) => found[f]).map((f) => [f, found[f]]));
}

export function canLeaveStep(step: BureauStepId, values: BureauCreateValues): boolean {
  return Object.keys(stepErrors(step, values)).length === 0;
}

// Sair da tela perde o que foi digitado: só pede confirmação se há algo a perder.
export function hasTypedData(values: BureauCreateValues): boolean {
  return Object.values(values).some((v) => v.trim() !== "");
}
