"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import type { DbIdentity } from "@/lib/db/transaction";
import {
  deleteSettings,
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
import { SCR_SETTING_KEYS } from "@/lib/scr/consent-term";
import { assertSplitWithin100, lockCommissionSplit, SplitOver100Error } from "@/lib/commission/queries";
import { bureauCommissionSchema } from "@/lib/validators/catalog";
import {
  AFFILIATE_SETTING_KEYS,
  BUREAU_COMMISSION_KEY,
  MAX_PAYABLE_RETENTION_DAYS,
  PAYABLE_RETENTION_KEY,
  asString,
  readAiPrompt,
  readScrTermSettings,
  type ScrTermSettings,
} from "@/lib/settings/readers";

// Exported readers are public endpoints ("use server"): reject roles without settings:read (client).
async function readerIdentity(): Promise<DbIdentity> {
  const session = await getRequiredSession();
  if (!hasPermission(session, "settings:read")) throw new Error("Não autorizado.");
  return session;
}

async function adminIdentity(): Promise<DbIdentity | null> {
  try {
    const session = await getRequiredSession();
    if (!hasPermission(session, "settings:write")) return null;
    return session;
  } catch {
    return null;
  }
}

// ── AI prompts ────────────────────────────────────────────────────────────

export async function getAiPrompt(kind: AiPromptKind): Promise<string> {
  return readAiPrompt(await readerIdentity(), kind);
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
    return { error: "Apenas o superadmin pode editar os prompts." };
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

  revalidatePath("/superadmin/settings/prompts");
  return { error: null };
}

// ── Termo SCR (autogestão) ────────────────────────────────────────────────

export type { ScrTermSettings };

export async function getScrTermSettings(): Promise<ScrTermSettings> {
  return readScrTermSettings(await readerIdentity());
}

export async function saveScrTermSettings(
  input: ScrTermSettings
): Promise<SaveResult> {
  const identity = await adminIdentity();
  if (!identity) {
    return { error: "Apenas o superadmin pode editar o termo SCR." };
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

  revalidatePath("/superadmin/settings/scr");
  return { error: null };
}

// ── Afiliados (carência da comissão e taxa de saque) ──────────────────────

const MAX_HOLD_DAYS = 365;
const moneyField = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, "Valor inválido.")
  .transform(Number);
const affiliateSettingsSchema = z.object({
  holdDays: z.number().int("Informe dias inteiros.").min(0, "Dias inválidos.").max(MAX_HOLD_DAYS, "Use no máximo 365 dias."),
  fixed: moneyField,
  percent: moneyField.refine((v) => v <= 100, "A taxa percentual vai de 0 a 100."),
});

export async function saveAffiliateSettings(values: unknown): Promise<SaveResult> {
  const parsed = affiliateSettingsSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const identity = await adminIdentity();
  if (!identity) return { error: "Apenas o superadmin pode editar as regras de afiliados." };

  try {
    await upsertSettings(
      identity,
      [
        { key: AFFILIATE_SETTING_KEYS.holdDays, value: parsed.data.holdDays },
        {
          key: AFFILIATE_SETTING_KEYS.withdrawalFee,
          value: { fixed: parsed.data.fixed, percent: parsed.data.percent },
        },
      ],
      "settings.affiliates",
    );
  } catch {
    return { error: "Falha ao salvar as regras de afiliados." };
  }

  revalidatePath("/superadmin/settings/afiliados");
  return { error: null };
}

// ── Repasses (prazo de retenção do valor a receber) ───────────────────────

const payableRetentionSchema = z.object({
  days: z
    .number({ invalid_type_error: "Informe o número de dias." })
    .int("Informe dias inteiros.")
    .min(0, "Dias inválidos.")
    .max(MAX_PAYABLE_RETENTION_DAYS, `Use no máximo ${MAX_PAYABLE_RETENTION_DAYS} dias.`),
});

export async function savePayableRetentionAction(values: unknown): Promise<SaveResult> {
  const parsed = payableRetentionSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const identity = await adminIdentity();
  if (!identity) return { error: "Apenas o superadmin pode editar o prazo dos repasses." };

  try {
    await upsertSettings(
      identity,
      [{ key: PAYABLE_RETENTION_KEY, value: parsed.data.days }],
      "settings.payable_retention",
      {
        auditChange: (previous) => {
          const from = previous.get(PAYABLE_RETENTION_KEY);
          return { from: typeof from === "number" ? from : null, to: parsed.data.days };
        },
      },
    );
  } catch {
    return { error: "Falha ao salvar o prazo dos repasses." };
  }

  revalidatePath("/superadmin/settings/repasses");
  return { error: null };
}

// ── Comissão dos Bureaus (% global sobre o preço bruto) ───────────────────

export async function saveBureauCommissionAction(values: unknown): Promise<SaveResult> {
  const parsed = bureauCommissionSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const identity = await adminIdentity();
  if (!identity || identity.supportSessionId) return { error: "Apenas o superadmin pode editar a comissão dos Bureaus." };

  try {
    await upsertSettings(
      identity,
      [{ key: BUREAU_COMMISSION_KEY, value: parsed.data.pct }],
      "settings.bureau_commission",
      {
        auditChange: (previous) => {
          const from = previous.get(BUREAU_COMMISSION_KEY);
          return { from: typeof from === "number" ? from : null, to: parsed.data.pct };
        },
        // A % global vale para todo Bureau sem override: nenhum pode passar de 100 com a % de afiliados.
        beforeWrite: lockCommissionSplit,
        keepSupportSession: true,
        afterWrite: (client) => assertSplitWithin100(client, null),
      },
    );
  } catch (error) {
    if (error instanceof SplitOver100Error) {
      return { error: "A comissão passa de 100% somada à % de afiliados de algum Bureau." };
    }
    return { error: "Falha ao salvar a comissão dos Bureaus." };
  }

  revalidatePath("/superadmin/settings/comissao");
  revalidatePath("/settings/catalog");
  return { error: null };
}
