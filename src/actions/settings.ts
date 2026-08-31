"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import type { DbIdentity } from "@/lib/db/transaction";
import {
  deleteSettings,
  readSetting,
  readSettings,
  upsertSettings,
} from "@/lib/settings/queries";
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

async function readerIdentity(): Promise<DbIdentity> {
  const session = await getRequiredSession();
  return { userId: session.userId, role: session.role };
}

async function adminIdentity(): Promise<DbIdentity | null> {
  try {
    const session = await getRequiredSession();
    if (!hasPermission(session.role, "settings:write")) return null;
    return { userId: session.userId, role: session.role };
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// ── AI prompts ────────────────────────────────────────────────────────────

async function readStored(kind: AiPromptKind): Promise<string | null> {
  return asString(await readSetting(await readerIdentity(), aiPromptKey(kind)));
}

export async function getAiPrompt(kind: AiPromptKind): Promise<string> {
  return (await readStored(kind)) ?? DEFAULT_AI_PROMPTS[kind];
}

export interface AiPromptEntry {
  kind: AiPromptKind;
  label: string;
  value: string;
  defaultValue: string;
  isCustom: boolean;
}

export async function getAiPrompts(): Promise<AiPromptEntry[]> {
  const stored = await readSettings(
    await readerIdentity(),
    AI_PROMPT_KINDS.map(aiPromptKey),
  );
  return AI_PROMPT_KINDS.map((kind) => {
    const value = asString(stored.get(aiPromptKey(kind)));
    return {
      kind,
      label: AI_PROMPT_LABEL[kind],
      value: value ?? DEFAULT_AI_PROMPTS[kind],
      defaultValue: DEFAULT_AI_PROMPTS[kind],
      isCustom: value !== null,
    };
  });
}

export interface SaveAiPromptsInput {
  pf: string;
  pj: string;
  empresa: string;
}

export interface SaveResult {
  error: string | null;
}

export async function saveAiPrompts(input: SaveAiPromptsInput): Promise<SaveResult> {
  const identity = await adminIdentity();
  if (!identity) {
    return { error: "Apenas administradores podem editar os prompts." };
  }

  const values: Record<AiPromptKind, string> = {
    pf: input.pf,
    pj: input.pj,
    empresa: input.empresa,
  };

  const toWrite: { key: string; value: unknown; description?: string }[] = [];
  const toDelete: string[] = [];
  for (const kind of AI_PROMPT_KINDS) {
    const trimmed = values[kind].trim();
    const key = aiPromptKey(kind);
    if (trimmed.length === 0 || trimmed === DEFAULT_AI_PROMPTS[kind].trim()) {
      toDelete.push(key);
    } else {
      toWrite.push({
        key,
        value: trimmed,
        description: `System prompt — ${AI_PROMPT_LABEL[kind]}`,
      });
    }
  }

  try {
    if (toWrite.length > 0) {
      await upsertSettings(identity, toWrite, "settings.prompts_update");
    }
    if (toDelete.length > 0) {
      await deleteSettings(identity, toDelete, "settings.prompts_reset");
    }
  } catch {
    return { error: "Falha ao salvar os prompts." };
  }

  revalidatePath("/settings/prompts");
  return { error: null };
}

// ── Comissão padrão estimada ──────────────────────────────────────────────

const COMMISSION_RATE_KEY = "default_commission_rate";
const DEFAULT_COMMISSION_RATE = 6; // % do valor aprovado

export async function getCommissionRate(): Promise<number> {
  const raw = await readSetting(await readerIdentity(), COMMISSION_RATE_KEY);
  const num =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(num) && num >= 0 && num <= 100
    ? num
    : DEFAULT_COMMISSION_RATE;
}

export async function saveCommissionRate(rate: number): Promise<SaveResult> {
  const identity = await adminIdentity();
  if (!identity) {
    return { error: "Apenas administradores podem editar a comissão." };
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { error: "Informe um percentual entre 0 e 100." };
  }

  try {
    await upsertSettings(
      identity,
      [
        {
          key: COMMISSION_RATE_KEY,
          value: rate,
          description:
            "Comissão bruta padrão estimada (% do valor aprovado) usada no Dashboard",
        },
      ],
      "settings.commission_update",
    );
  } catch {
    return { error: "Falha ao salvar a comissão." };
  }

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

export async function getScrTermSettings(): Promise<ScrTermSettings> {
  const stored = await readSettings(await readerIdentity(), [
    SCR_SETTING_KEYS.authorizedName,
    SCR_SETTING_KEYS.authorizedDocument,
    SCR_SETTING_KEYS.institutionName,
    SCR_SETTING_KEYS.city,
  ]);
  const pick = (key: string, fallback: string) =>
    asString(stored.get(key)) ?? fallback;
  return {
    authorizedName: pick(
      SCR_SETTING_KEYS.authorizedName,
      SCR_TERM_DEFAULTS.authorizedName,
    ),
    authorizedDocument: pick(
      SCR_SETTING_KEYS.authorizedDocument,
      SCR_TERM_DEFAULTS.authorizedDocument,
    ),
    institutionName: pick(
      SCR_SETTING_KEYS.institutionName,
      SCR_TERM_DEFAULTS.institutionName,
    ),
    city: pick(SCR_SETTING_KEYS.city, SCR_TERM_DEFAULTS.city),
  };
}

export async function saveScrTermSettings(
  input: ScrTermSettings
): Promise<SaveResult> {
  const identity = await adminIdentity();
  if (!identity) {
    return { error: "Apenas administradores podem editar o termo SCR." };
  }

  const authorizedName = input.authorizedName.trim();
  const institutionName = input.institutionName.trim();
  const city = input.city.trim();
  if (
    authorizedName.length === 0 ||
    institutionName.length === 0 ||
    city.length === 0
  ) {
    return { error: "Preencha nome, instituição e cidade do termo." };
  }

  try {
    await upsertSettings(
      identity,
      [
        { key: SCR_SETTING_KEYS.authorizedName, value: authorizedName },
        { key: SCR_SETTING_KEYS.institutionName, value: institutionName },
        { key: SCR_SETTING_KEYS.city, value: city },
        {
          key: SCR_SETTING_KEYS.authorizedDocument,
          value: input.authorizedDocument.trim(),
        },
      ],
      "settings.scr_update",
    );
  } catch {
    return { error: "Falha ao salvar o termo SCR." };
  }

  revalidatePath("/settings/scr");
  return { error: null };
}
