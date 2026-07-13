"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import {
  AI_PROMPT_KINDS,
  AI_PROMPT_LABEL,
  DEFAULT_AI_PROMPTS,
  aiPromptKey,
  type AiPromptKind,
} from "@/lib/ai/prompt";
import {
  SCR_SETTING_KEYS,
  SCR_TERM_DEFAULTS,
} from "@/lib/scr/consent-term";
import type { Database } from "@/types/supabase";

function db(): SupabaseClient<Database> {
  return createClient();
}

// Lê o valor bruto armazenado para uma chave de prompt (ou null).
async function readStored(kind: AiPromptKind): Promise<string | null> {
  const { data } = await db()
    .from("settings")
    .select("value")
    .eq("key", aiPromptKey(kind))
    .maybeSingle();
  const value = (data as { value: unknown } | null)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// Prompt efetivo (customizado no banco ou default em código). Usado na geração.
export async function getAiPrompt(kind: AiPromptKind): Promise<string> {
  return (await readStored(kind)) ?? DEFAULT_AI_PROMPTS[kind];
}

export interface AiPromptEntry {
  kind: AiPromptKind;
  label: string;
  value: string; // efetivo (customizado ou default)
  defaultValue: string; // default em código (para "restaurar padrão")
  isCustom: boolean;
}

// Todos os prompts para a tela de edição.
export async function getAiPrompts(): Promise<AiPromptEntry[]> {
  const entries = await Promise.all(
    AI_PROMPT_KINDS.map(async (kind) => {
      const stored = await readStored(kind);
      return {
        kind,
        label: AI_PROMPT_LABEL[kind],
        value: stored ?? DEFAULT_AI_PROMPTS[kind],
        defaultValue: DEFAULT_AI_PROMPTS[kind],
        isCustom: stored !== null,
      };
    })
  );
  return entries;
}

export interface SaveAiPromptsInput {
  pf: string;
  pj: string;
  empresa: string;
}

export interface SaveResult {
  error: string | null;
}

// Salva os 3 prompts (admin). Texto igual ao default (ou vazio) remove a chave,
// mantendo o prompt "ligado" ao default do código. settings não tem política de
// escrita RLS → grava via service-role após checar admin.
export async function saveAiPrompts(input: SaveAiPromptsInput): Promise<SaveResult> {
  if (!(await isAdmin())) {
    return { error: "Apenas administradores podem editar os prompts." };
  }

  const {
    data: { user },
  } = await createClient().auth.getUser();

  const admin = createServiceClient();
  const values: Record<AiPromptKind, string> = {
    pf: input.pf,
    pj: input.pj,
    empresa: input.empresa,
  };

  for (const kind of AI_PROMPT_KINDS) {
    const trimmed = values[kind].trim();
    const key = aiPromptKey(kind);

    // Vazio ou idêntico ao default → remove (volta a seguir o default do código).
    if (trimmed.length === 0 || trimmed === DEFAULT_AI_PROMPTS[kind].trim()) {
      const { error } = await admin.from("settings").delete().eq("key", key);
      if (error) return { error: error.message };
      continue;
    }

    const { error } = await admin.from("settings").upsert(
      {
        key,
        value: trimmed,
        description: `System prompt — ${AI_PROMPT_LABEL[kind]}`,
        updated_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
    if (error) return { error: error.message };
  }

  revalidatePath("/settings/prompts");
  return { error: null };
}

// ── Comissão padrão estimada ──────────────────────────────────────────────

const COMMISSION_RATE_KEY = "default_commission_rate";
const DEFAULT_COMMISSION_RATE = 6; // % do valor aprovado

// Taxa efetiva (configurada no banco ou default em código). Usada no Dashboard.
export async function getCommissionRate(): Promise<number> {
  const { data } = await createServiceClient()
    .from("settings")
    .select("value")
    .eq("key", COMMISSION_RATE_KEY)
    .maybeSingle();
  const raw = (data as { value: unknown } | null)?.value;
  const num =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(num) && num >= 0 && num <= 100
    ? num
    : DEFAULT_COMMISSION_RATE;
}

export async function saveCommissionRate(rate: number): Promise<SaveResult> {
  if (!(await isAdmin())) {
    return { error: "Apenas administradores podem editar a comissão." };
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { error: "Informe um percentual entre 0 e 100." };
  }
  const {
    data: { user },
  } = await createClient().auth.getUser();

  const { error } = await createServiceClient()
    .from("settings")
    .upsert(
      {
        key: COMMISSION_RATE_KEY,
        value: rate,
        description:
          "Comissão bruta padrão estimada (% do valor aprovado) usada no Dashboard",
        updated_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
  if (error) return { error: error.message };

  revalidatePath("/settings/commission");
  revalidatePath("/");
  return { error: null };
}

// ── Termo SCR (autogestão) ────────────────────────────────────────────────

export interface ScrTermSettings {
  authorizedName: string;
  authorizedDocument: string;
  institutionName: string;
  city: string;
}

// Lê um setting de texto (jsonb string) com fallback.
async function readSettingString(
  supabase: SupabaseClient<Database>,
  key: string,
  fallback: string
): Promise<string> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const value = (data as { value: unknown } | null)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

// Configurações efetivas do termo SCR (usadas no disparo da autorização).
export async function getScrTermSettings(): Promise<ScrTermSettings> {
  const supabase = createServiceClient();
  const [authorizedName, authorizedDocument, institutionName, city] =
    await Promise.all([
      readSettingString(
        supabase,
        SCR_SETTING_KEYS.authorizedName,
        SCR_TERM_DEFAULTS.authorizedName
      ),
      readSettingString(
        supabase,
        SCR_SETTING_KEYS.authorizedDocument,
        SCR_TERM_DEFAULTS.authorizedDocument
      ),
      readSettingString(
        supabase,
        SCR_SETTING_KEYS.institutionName,
        SCR_TERM_DEFAULTS.institutionName
      ),
      readSettingString(supabase, SCR_SETTING_KEYS.city, SCR_TERM_DEFAULTS.city),
    ]);
  return { authorizedName, authorizedDocument, institutionName, city };
}

export async function saveScrTermSettings(
  input: ScrTermSettings
): Promise<SaveResult> {
  if (!(await isAdmin())) {
    return { error: "Apenas administradores podem editar o termo SCR." };
  }
  const {
    data: { user },
  } = await createClient().auth.getUser();

  const admin = createServiceClient();
  // CNPJ do operador é opcional; nome, instituição e cidade são obrigatórios.
  const required: { key: string; value: string }[] = [
    { key: SCR_SETTING_KEYS.authorizedName, value: input.authorizedName.trim() },
    { key: SCR_SETTING_KEYS.institutionName, value: input.institutionName.trim() },
    { key: SCR_SETTING_KEYS.city, value: input.city.trim() },
  ];
  if (required.some((e) => e.value.length === 0)) {
    return { error: "Preencha nome, instituição e cidade do termo." };
  }
  const entries: { key: string; value: string }[] = [
    ...required,
    {
      key: SCR_SETTING_KEYS.authorizedDocument,
      value: input.authorizedDocument.trim(),
    },
  ];
  for (const e of entries) {
    const { error } = await admin.from("settings").upsert(
      {
        key: e.key,
        value: e.value,
        updated_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
    if (error) return { error: error.message };
  }

  revalidatePath("/settings/scr");
  return { error: null };
}
