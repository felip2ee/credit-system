"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import type { DbIdentity } from "@/lib/db/transaction";
import {
  addClientNote as addClientNoteQuery,
  createClientRecord as createClientRecordQuery,
  linkPartner as linkPartnerQuery,
  updateClientRecord as updateClientRecordQuery,
  updateClientStatus as updateClientStatusQuery,
} from "@/lib/clients/queries";
import { clientSchema, type ClientFormValues } from "@/lib/validators/client";
import { isValidCPF, onlyDigits } from "@/lib/utils";
import type { CrmClientStatus } from "@/types/app";

export interface ActionResult {
  error: string | null;
  id?: string;
}

async function requireClientWrite(): Promise<DbIdentity | null> {
  try {
    const session = await getRequiredSession();
    if (!hasPermission(session.role, "clients:write")) return null;
    return { userId: session.userId, role: session.role };
  } catch {
    return null;
  }
}

export async function createClientRecord(
  values: ClientFormValues
): Promise<ActionResult> {
  const parsed = clientSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const identity = await requireClientWrite();
  if (!identity) return { error: "Sessão expirada." };

  try {
    const result = await createClientRecordQuery(identity, parsed.data);
    if (!result.ok) {
      return { error: "Já existe um cliente com este documento." };
    }
    revalidatePath("/clients");
    return { error: null, id: result.id };
  } catch {
    return { error: "Falha ao salvar o cliente." };
  }
}

export async function updateClientRecord(
  id: string,
  values: ClientFormValues
): Promise<ActionResult> {
  const parsed = clientSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const identity = await requireClientWrite();
  if (!identity) return { error: "Sessão expirada." };

  try {
    await updateClientRecordQuery(identity, id, parsed.data);
  } catch {
    return { error: "Falha ao salvar o cliente." };
  }

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { error: null, id };
}

export async function updateClientStatus(
  id: string,
  status: CrmClientStatus
): Promise<ActionResult> {
  const identity = await requireClientWrite();
  if (!identity) return { error: "Sessão expirada." };

  try {
    await updateClientStatusQuery(identity, id, status);
  } catch {
    return { error: "Falha ao alterar o status." };
  }

  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
  return { error: null, id };
}

export async function addClientNote(
  clientId: string,
  content: string
): Promise<ActionResult> {
  const text = content.trim();
  if (text.length < 1) return { error: "Anotação vazia." };

  const identity = await requireClientWrite();
  if (!identity) return { error: "Sessão expirada." };

  try {
    await addClientNoteQuery(identity, clientId, text);
  } catch {
    return { error: "Falha ao salvar a anotação." };
  }

  revalidatePath(`/clients/${clientId}`);
  return { error: null, id: clientId };
}

export interface LinkPartnerInput {
  cpf: string;
  name: string;
  percentage?: number | null;
  role?: string | null;
}

export async function linkPartner(
  pjClientId: string,
  input: LinkPartnerInput
): Promise<ActionResult> {
  if (!isValidCPF(input.cpf)) return { error: "CPF do sócio inválido." };
  const name = input.name.trim();
  if (name.length < 3) return { error: "Informe o nome do sócio." };

  const identity = await requireClientWrite();
  if (!identity) return { error: "Sessão expirada." };

  try {
    const result = await linkPartnerQuery(identity, pjClientId, {
      document: onlyDigits(input.cpf),
      name,
      percentage: input.percentage ?? null,
      role: input.role ?? null,
    });
    if (!result.ok) {
      return {
        error:
          result.reason === "self_link"
            ? "Não é possível vincular o cliente a ele mesmo."
            : "Sócio já vinculado.",
      };
    }
    revalidatePath(`/clients/${pjClientId}`);
    return { error: null, id: result.id };
  } catch {
    return { error: "Falha ao criar o sócio." };
  }
}

export interface CnpjLookupResult {
  error: string | null;
  data?: {
    name: string;
    fantasia: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    address_number: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
    zip_code: string | null;
    situacao: string | null;
  };
}

export async function lookupCnpj(cnpj: string): Promise<CnpjLookupResult> {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { error: "CNPJ deve ter 14 dígitos." };

  try {
    const res = await fetch(
      `https://brasilapi.com.br/api/cnpj/v1/${digits}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "ReinoDoCredito/1.0 (+crm)",
        },
      }
    );
    if (!res.ok) {
      return {
        error:
          res.status === 404
            ? "CNPJ não encontrado na Receita Federal."
            : "Falha ao consultar a Receita Federal.",
      };
    }
    const j = (await res.json()) as Record<string, unknown>;
    const str = (k: string) => {
      const v = j[k];
      return typeof v === "string" && v.length > 0 ? v : null;
    };
    return {
      error: null,
      data: {
        name: str("razao_social") ?? "",
        fantasia: str("nome_fantasia"),
        email: str("email"),
        phone: str("ddd_telefone_1"),
        address: str("logradouro"),
        address_number: str("numero"),
        neighborhood: str("bairro"),
        city: str("municipio"),
        state: str("uf"),
        zip_code: str("cep"),
        situacao: str("descricao_situacao_cadastral"),
      },
    };
  } catch {
    return { error: "Não foi possível consultar a Receita Federal." };
  }
}
