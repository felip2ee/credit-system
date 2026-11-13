export const BRAND_THEMES = ["atual", "classico"] as const;
export type BrandTheme = (typeof BRAND_THEMES)[number];

/** Lê `BRAND_THEME`. Valor ausente ou desconhecido vale `atual` (nunca lança erro). */
export function resolveBrandTheme(raw: string | undefined): BrandTheme {
	return raw?.trim().toLowerCase() === "classico" ? "classico" : "atual";
}
