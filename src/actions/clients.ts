"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { clientSchema, type ClientFormValues } from "@/lib/validators/client";
import { isValidCPF, onlyDigits } from "@/lib/utils";
import type { Database } from "@/types/supabase";
import type { CrmClientStatus } from "@/types/app";

// Alias curto para o client server-side. A ponte de tipo que faz .insert/.update
// resolverem corretamente vive em lib/supabase/server.ts (createClient já retorna
// SupabaseClient<Database>); aqui é só conveniência de nome.
function db(): SupabaseClient<Database> {
  return createClient();
}

async function currentUserId(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export interface ActionResult {
  error: string | null;
  id?: string;
}

export async function createClientRecord(
  values: ClientFormValues
): Promise<ActionResult> {
  const parsed = clientSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const data = parsed.data;

  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const { data: existing } = await supabase
    .from("crm_clients")
    .select("id")
    .eq("document", data.document)
    .maybeSingle();
  if (existing) {
    return { error: "Já existe um cliente com este documento." };
  }

  const { data: inserted, error } = await supabase
    .from("crm_clients")
    .insert({
      type: data.type,
      name: data.name,
      document: data.document,
      email: data.email,
      phone: data.phone,
      address: data.address,
      address_number: data.address_number,
      address_complement: data.address_complement,
      neighborhood: data.neighborhood,
      city: data.city,
      state: data.state,
      zip_code: data.zip_code,
      status: data.status,
      notes: data.notes,
      created_by: userId,
      assigned_to: userId,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    return { error: error?.message ?? "Falha ao salvar o cliente." };
  }

  const clientId = (inserted as { id: string }).id;

  await supabase.from("crm_client_documents").insert({
    client_id: clientId,
    type: data.type,
    document: data.document,
    label: data.type === "PJ" ? "CNPJ principal" : "CPF",
    is_primary: true,
  });

  await supabase.from("timeline_events").insert({
    entity_type: "crm_client",
    entity_id: clientId,
    event_type: "client.created",
    title: "Cliente cadastrado",
    description: data.name,
    created_by: userId,
  });

  revalidatePath("/clients");
  return { error: null, id: clientId };
}

export async function updateClientRecord(
  id: string,
  values: ClientFormValues
): Promise<ActionResult> {
  const parsed = clientSchema.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const data = parsed.data;
  const supabase = db();

  const { error } = await supabase
    .from("crm_clients")
    .update({
      name: data.name,
      email: data.email,
      phone: data.phone,
      address: data.address,
      address_number: data.address_number,
      address_complement: data.address_complement,
      neighborhood: data.neighborhood,
      city: data.city,
      state: data.state,
      zip_code: data.zip_code,
      notes: data.notes,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { error: null, id };
}

export async function updateClientStatus(
  id: string,
  status: CrmClientStatus
): Promise<ActionResult> {
  const supabase = db();
  const userId = await currentUserId();

  const { error } = await supabase
    .from("crm_clients")
    .update({ status })
    .eq("id", id);
  if (error) return { error: error.message };

  await supabase.from("timeline_events").insert({
    entity_type: "crm_client",
    entity_id: id,
    event_type: "client.status_changed",
    title: "Status alterado",
    metadata: { to: status },
    created_by: userId,
  });

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

  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const { error } = await supabase.from("crm_notes").insert({
    entity_type: "crm_client",
    entity_id: clientId,
    content: text,
    created_by: userId,
  });
  if (error) return { error: error.message };

  await supabase.from("timeline_events").insert({
    entity_type: "crm_client",
    entity_id: clientId,
    event_type: "note.added",
    title: "Anotação adicionada",
    description: text.slice(0, 140),
    created_by: userId,
  });

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

  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const document = onlyDigits(input.cpf);

  // Encontra ou cria o cliente PF do sócio.
  const { data: existingPf } = await supabase
    .from("crm_clients")
    .select("id")
    .eq("document", document)
    .maybeSingle();

  let partnerId: string;
  if (existingPf) {
    partnerId = (existingPf as { id: string }).id;
  } else {
    const { data: createdPf, error: pfErr } = await supabase
      .from("crm_clients")
      .insert({
        type: "PF",
        name,
        document,
        status: "prospect",
        created_by: userId,
        assigned_to: userId,
      })
      .select("id")
      .single();
    if (pfErr || !createdPf) {
      return { error: pfErr?.message ?? "Falha ao criar o sócio." };
    }
    partnerId = (createdPf as { id: string }).id;
    await supabase.from("crm_client_documents").insert({
      client_id: partnerId,
      type: "PF",
      document,
      label: "CPF",
      is_primary: true,
    });
  }

  if (partnerId === pjClientId) {
    return { error: "Não é possível vincular o cliente a ele mesmo." };
  }

  const { error: relErr } = await supabase.from("crm_client_relations").insert({
    client_id: pjClientId,
    related_id: partnerId,
    relation_type: "socio",
    percentage: input.percentage ?? null,
    role: input.role ?? null,
  });
  if (relErr) {
    if (relErr.code === "23505") return { error: "Sócio já vinculado." };
    return { error: relErr.message };
  }

  revalidatePath(`/clients/${pjClientId}`);
  return { error: null, id: partnerId };
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
