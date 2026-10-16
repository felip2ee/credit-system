"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import {
  addHolderNote as addHolderNoteQuery,
  createHolder as createHolderQuery,
  linkPartner as linkPartnerQuery,
  updateHolder as updateHolderQuery,
} from "@/lib/holders/queries";
import { holderSchema, linkPartnerSchema, type HolderFormValues } from "@/lib/validators/holder";
import { isUuid } from "@/lib/validators/id";
import { onlyDigits } from "@/lib/utils";

export interface ActionResult {
  error: string | null;
  id?: string;
}

async function requireHolderWrite(): Promise<RequiredSession | null> {
  try {
    const session = await getRequiredSession();
    return hasPermission(session, "holders:write") ? session : null;
  } catch {
    return null;
  }
}

const DUPLICATE_MESSAGE = "Já existe um Titular com este documento.";
const NOT_FOUND_MESSAGE = "Titular não encontrado.";
const UPDATE_FAILURES = {
  not_found: NOT_FOUND_MESSAGE,
  duplicate_document: DUPLICATE_MESSAGE,
  anonymized: "Titular anonimizado. Nenhuma edição é permitida.",
} as const;

export async function createHolder(values: HolderFormValues): Promise<ActionResult> {
  const parsed = holderSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const session = await requireHolderWrite();
  if (!session) return { error: "Sessão expirada." };

  try {
    const result = await createHolderQuery(session, parsed.data);
    if (!result.ok) return { error: DUPLICATE_MESSAGE };
    revalidatePath("/holders");
    return { error: null, id: result.id };
  } catch {
    return { error: "Falha ao salvar o Titular." };
  }
}

export async function updateHolder(id: string, values: HolderFormValues): Promise<ActionResult> {
  if (!isUuid(id)) return { error: NOT_FOUND_MESSAGE };
  const parsed = holderSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const session = await requireHolderWrite();
  if (!session) return { error: "Sessão expirada." };

  try {
    const result = await updateHolderQuery(session, id, parsed.data);
    if (!result.ok) {
      return { error: UPDATE_FAILURES[result.reason] };
    }
  } catch {
    return { error: "Falha ao salvar o Titular." };
  }

  revalidatePath("/holders");
  revalidatePath(`/holders/${id}`);
  return { error: null, id };
}

export async function addHolderNote(holderId: string, content: string): Promise<ActionResult> {
  if (!isUuid(holderId)) return { error: NOT_FOUND_MESSAGE };
  const text = content.trim();
  if (text.length < 1) return { error: "Anotação vazia." };

  const session = await requireHolderWrite();
  if (!session) return { error: "Sessão expirada." };

  try {
    const result = await addHolderNoteQuery(session, holderId, text);
    if (!result.ok) return { error: NOT_FOUND_MESSAGE };
  } catch {
    return { error: "Falha ao salvar a anotação." };
  }

  revalidatePath(`/holders/${holderId}`);
  return { error: null, id: holderId };
}

export interface LinkPartnerInput {
  cpf: string;
  name: string;
  percentage?: number | null;
  role?: string | null;
}

export async function linkPartner(companyId: string, input: LinkPartnerInput): Promise<ActionResult> {
  if (!isUuid(companyId)) return { error: NOT_FOUND_MESSAGE };
  const parsed = linkPartnerSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  const session = await requireHolderWrite();
  if (!session) return { error: "Sessão expirada." };

  try {
    const result = await linkPartnerQuery(session, companyId, parsed.data);
    if (!result.ok) {
      return {
        error:
          result.reason === "self_link"
            ? "Não é possível vincular o Titular a ele mesmo."
            : "A empresa precisa ser um Titular pessoa jurídica.",
      };
    }
    revalidatePath(`/holders/${companyId}`);
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
