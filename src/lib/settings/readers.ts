// Leitores de configuração sem "use server": o tick roda sem sessão e passa a identidade do Bureau.
// As Server Actions de settings.ts só chamam estes leitores com a identidade da sessão.
import type { DbIdentity } from "@/lib/db/transaction";
import { DEFAULT_AI_PROMPTS, aiPromptKey, type AiPromptKind } from "@/lib/ai/prompt";
import { SCR_SETTING_KEYS, SCR_TERM_DEFAULTS } from "@/lib/scr/consent-term";
import { readSetting, readSettings } from "@/lib/settings/queries";

export interface ScrTermSettings {
	authorizedName: string;
	authorizedDocument: string;
	institutionName: string;
	city: string;
}

export function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function readAiPrompt(identity: DbIdentity, kind: AiPromptKind): Promise<string> {
	return asString(await readSetting(identity, aiPromptKey(kind))) ?? DEFAULT_AI_PROMPTS[kind];
}

export async function readScrTermSettings(identity: DbIdentity): Promise<ScrTermSettings> {
	const stored = await readSettings(identity, [
		SCR_SETTING_KEYS.authorizedName,
		SCR_SETTING_KEYS.authorizedDocument,
		SCR_SETTING_KEYS.institutionName,
		SCR_SETTING_KEYS.city,
	]);
	const pick = (key: string, fallback: string) => asString(stored.get(key)) ?? fallback;
	return {
		authorizedName: pick(SCR_SETTING_KEYS.authorizedName, SCR_TERM_DEFAULTS.authorizedName),
		authorizedDocument: pick(SCR_SETTING_KEYS.authorizedDocument, SCR_TERM_DEFAULTS.authorizedDocument),
		institutionName: pick(SCR_SETTING_KEYS.institutionName, SCR_TERM_DEFAULTS.institutionName),
		city: pick(SCR_SETTING_KEYS.city, SCR_TERM_DEFAULTS.city),
	};
}
