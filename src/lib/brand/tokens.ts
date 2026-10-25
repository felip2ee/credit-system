// Espelho em hex das variáveis CSS de src/app/globals.css. Mude os dois juntos (e tailwind.config.ts).
export const BRAND_COLORS = {
	brand: "#009C97",
	cream: "#FCEDCE",
	ink: "#122C2B",
	primary: "#007A76",
	primaryForeground: "#FFFFFF",
	background: "#FFFFFF",
	foreground: "#122C2B",
	muted: "#F3F4F6",
	mutedForeground: "#4A5E5D",
	// Borda de controle (campo, caixa de seleção): >= 3:1 no branco.
	controlBorder: "#7D9291",
	// Borda de cartão plano: decorativa, sem texto nem controle dentro dela.
	hairline: "#E5E7EB",
	// Fundo de seção alternado com o branco.
	surface: "#F5F7FA",
	// Fundo de tag positiva e de item ativo; texto sobre ele usa brandSoftForeground.
	brandSoft: "#E6F4F3",
	brandSoftForeground: "#00514E",
	focus: "#007A76",
} as const;

// Neutros (mesma escala do Tailwind gray). 400 só para ícone grande/inativo decorativo, nunca texto de leitura.
export const NEUTRAL_COLORS = {
	50: "#F9FAFB",
	100: "#F3F4F6",
	200: "#E5E7EB",
	300: "#D1D5DB",
	400: "#9CA3AF",
	500: "#6B7280",
	600: "#4B5563",
	700: "#374151",
	800: "#1F2937",
	900: "#111827",
} as const;

export type StateName = "success" | "waiting" | "progress" | "attention" | "danger" | "neutral";

export const STATE_COLORS: Record<StateName, { bg: string; fg: string; border: string }> = {
	success: { bg: "#E2F3E7", fg: "#14532D", border: "#2F855A" },
	waiting: { bg: "#FCEFC7", fg: "#5C4200", border: "#9A7200" },
	progress: { bg: "#DDF0EF", fg: "#00514E", border: "#007A76" },
	attention: { bg: "#FFE6D0", fg: "#7A3300", border: "#B45309" },
	danger: { bg: "#FDE4E1", fg: "#8A1C14", border: "#C53030" },
	neutral: { bg: "#ECEFEE", fg: "#2F3F3E", border: "#6B7F7E" },
};
