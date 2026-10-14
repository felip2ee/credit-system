"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import {
  endSupportSession as endSupportSessionQuery,
  startSupportSession as startSupportSessionQuery,
  SUPPORT_REASON_MAX,
} from "@/lib/support/queries";

export interface SupportActionResult {
  error: string | null;
  id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para entrar em modo suporte.";

const startSchema = z.object({
  bureauId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(1, "Informe o motivo do suporte.")
    .max(SUPPORT_REASON_MAX, `O motivo deve ter no máximo ${SUPPORT_REASON_MAX} caracteres.`),
});

async function requireSupportEntry(): Promise<RequiredSession | null> {
  try {
    const session = await getRequiredSession();
    return hasPermission(session, "support:enter") ? session : null;
  } catch {
    return null;
  }
}

export async function startSupportSession(values: unknown): Promise<SupportActionResult> {
  const parsed = startSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const session = await requireSupportEntry();
  if (!session) return { error: NOT_ALLOWED };

  try {
    const result = await startSupportSessionQuery(session, parsed.data);
    if (!result.ok) {
      return {
        error:
          result.reason === "bureau_not_found"
            ? "Bureau não encontrado."
            : "Informe o motivo do suporte.",
      };
    }
    revalidatePath("/", "layout");
    return { error: null, id: result.id };
  } catch {
    return { error: "Falha ao iniciar o modo suporte." };
  }
}

export async function endSupportSession(): Promise<SupportActionResult> {
  const session = await requireSupportEntry();
  if (!session) return { error: NOT_ALLOWED };

  try {
    const result = await endSupportSessionQuery(session);
    if (!result.ok) return { error: "Nenhuma sessão de suporte ativa." };
    revalidatePath("/", "layout");
    return { error: null };
  } catch {
    return { error: "Falha ao encerrar o modo suporte." };
  }
}
