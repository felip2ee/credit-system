"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { sendInviteEmail } from "@/lib/auth/invite";
import {
  createBureau as createBureauQuery,
  inviteBureauAdmin as inviteBureauAdminQuery,
  setBureauAdminCredentials as setBureauAdminCredentialsQuery,
  setBureauStatus as setBureauStatusQuery,
  updateBureau as updateBureauQuery,
} from "@/lib/bureaus/queries";
import { hasPermission } from "@/lib/db/permissions";
import { bureauCreateSchema, bureauUpdateSchema } from "@/lib/validators/bureau";
import { optionalPasswordSchema } from "@/lib/validators/password";

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
  password: optionalPasswordSchema,
});

const credentialsSchema = z.object({
  bureauId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  password: optionalPasswordSchema,
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
  // Com senha temporária o admin entra direto: não há convite por e-mail.
  if (parsed.data.adminPassword) return { error: null, id: result.id };
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
    if (!result.ok) {
      const messages = {
        not_found: "Bureau não encontrado.",
        slug_taken: "Este endereço (slug) já está em uso ou pertence a um link antigo de outro Bureau.",
        slug_reserved: "Este endereço (slug) é reservado. Escolha outro.",
      } as const;
      return { error: messages[result.reason] };
    }
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
          ? parsed.data.password
            ? "Este usuário já existe. Use Definir senha."
            : "Este usuário já ativou a conta."
          : "E-mail já cadastrado. Peça ao administrador para usar 'Esqueci a senha' na tela de login.",
    };
  }
  // Com senha temporária o admin entra direto: não há convite por e-mail.
  if (parsed.data.password) return { error: null, id: result.userId };
  if (!(await sendInviteEmail(parsed.data.email))) return { error: INVITE_EMAIL_FAILED };
  return { error: null, id: result.userId };
}

// password ausente = só forçar a troca no próximo login.
export async function setBureauAdminCredentials(values: unknown): Promise<BureauActionResult> {
  const parsed = credentialsSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const session = await requireBureauManager();
  if (!session) return { error: NOT_ALLOWED };

  try {
    const result = await setBureauAdminCredentialsQuery(session, {
      bureauId: parsed.data.bureauId,
      email: parsed.data.email,
      password: parsed.data.password ?? null,
    });
    if (!result.ok) return { error: "Administrador não encontrado, ou ainda sem acesso. Defina uma senha." };
  } catch {
    return { error: "Falha ao definir a senha." };
  }
  return { error: null };
}
