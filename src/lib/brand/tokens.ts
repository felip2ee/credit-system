// Espelho em hex das variáveis CSS de src/app/globals.css. Mude os dois juntos.
export const BRAND_COLORS = {
	brand: "#009C97",
	cream: "#FCEDCE",
	ink: "#122C2B",
	primary: "#007A76",
	primaryForeground: "#FFFFFF",
	background: "#FFFFFF",
	foreground: "#122C2B",
	muted: "#F4EFE4",
	mutedForeground: "#4A5E5D",
	border: "#7D9291",
	focus: "#007A76",
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
