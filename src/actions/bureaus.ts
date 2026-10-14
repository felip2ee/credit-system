"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { sendInviteEmail } from "@/lib/auth/invite";
import {
  createBureau as createBureauQuery,
  inviteBureauAdmin as inviteBureauAdminQuery,
  setBureauStatus as setBureauStatusQuery,
  updateBureau as updateBureauQuery,
} from "@/lib/bureaus/queries";
import { hasPermission } from "@/lib/db/permissions";
import { bureauCreateSchema, bureauUpdateSchema } from "@/lib/validators/bureau";

export interface BureauActionResult {
  error: string | null;
  id?: string;
}

const EMAIL_FAILED = "Bureau criado, mas o e-mail falhou. Use Reenviar convite.";
const INVITE_EMAIL_FAILED = "Convite registrado, mas o e-mail falhou. Tente reenviar.";
const NOT_ALLOWED = "Você não tem permissão para gerenciar Bureaus.";

async function requireBureauManager(): Promise<RequiredSession | null> {
  try {
    const session = await getRequiredSession();
    return hasPermission(session, "bureaus:manage") ? session : null;
  } catch {
    return null;
  }
}

const inviteSchema = z.object({
  bureauId: z.string().uuid(),
  name: z.string().trim().min(3, "Informe o nome completo."),
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
});

export async function createBureau(values: unknown): Promise<BureauActionResult> {
  const parsed = bureauCreateSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const session = await requireBureauManager();
  if (!session) return { error: NOT_ALLOWED };

  let result;
  try {
    result = await createBureauQuery(session, parsed.data);
  } catch {
    return { error: "Falha ao criar o Bureau." };
  }
  if (!result.ok) {
    const messages = {
      slug_taken: "Este endereço (slug) já está em uso.",
      slug_reserved: "Este endereço (slug) é reservado. Escolha outro.",
      email_in_use: "Este e-mail já pertence a outro usuário.",
    } as const;
    return { error: messages[result.reason] };
  }

  revalidatePath("/superadmin");
  // O e-mail sai depois do commit: falha não desfaz o Bureau.
  if (!(await sendInviteEmail(result.adminEmail))) return { error: EMAIL_FAILED, id: result.id };
  return { error: null, id: result.id };
}

export async function updateBureau(values: unknown): Promise<BureauActionResult> {
  const parsed = bureauUpdateSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const session = await requireBureauManager();
  if (!session) return { error: NOT_ALLOWED };

  try {
    const result = await updateBureauQuery(session, parsed.data);
    if (!result.ok) return { error: "Bureau não encontrado." };
  } catch {
    return { error: "Falha ao salvar o Bureau." };
  }
  revalidatePath("/superadmin");
  revalidatePath(`/superadmin/bureaus/${parsed.data.id}`);
  return { error: null, id: parsed.data.id };
}

export async function setBureauStatus(id: string, status: unknown): Promise<BureauActionResult> {
  const parsed = z
    .object({ id: z.string().uuid(), status: z.enum(["active", "inactive"]) })
    .safeParse({ id, status });
  if (!parsed.success) return { error: "Dados inválidos." };
  const session = await requireBureauManager();
  if (!session) return { error: NOT_ALLOWED };

  try {
    const result = await setBureauStatusQuery(session, parsed.data.id, parsed.data.status);
    if (!result.ok) return { error: "Bureau não encontrado." };
  } catch {
    return { error: "Falha ao alterar o status do Bureau." };
  }
  revalidatePath("/superadmin");
  revalidatePath(`/superadmin/bureaus/${parsed.data.id}`);
  return { error: null, id: parsed.data.id };
}

export async function inviteBureauAdmin(values: unknown): Promise<BureauActionResult> {
  const parsed = inviteSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const session = await requireBureauManager();
  if (!session) return { error: NOT_ALLOWED };

  let result;
  try {
    result = await inviteBureauAdminQuery(session, parsed.data);
  } catch {
    return { error: "Falha ao registrar o convite." };
  }
  if (!result.ok) {
    return {
      error:
        result.reason === "already_member"
          ? "Este usuário já ativou a conta."
          : "Este e-mail já pertence a outro usuário.",
    };
  }
  if (!(await sendInviteEmail(parsed.data.email))) return { error: INVITE_EMAIL_FAILED };
  return { error: null, id: result.userId };
}
