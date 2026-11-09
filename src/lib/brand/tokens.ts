// Paleta do app (UI): verde escuro de fundo + amarelo de destaque; branco só em texto corrido. Espelha globals.css.
// PDF e e-mail seguem em BRAND_COLORS e STATE_COLORS (abaixo), fora desta paleta.
export const APP_COLORS = {
	background: "#05261F",
	card: "#0B3A2E",
	cardRaised: "#14473A",
	foreground: "#FFFFFF",
	mutedForeground: "#B9D2C8",
	primary: "#FFC400",
	primaryHover: "#E0A800",
	primaryForeground: "#05261F",
	destructive: "#FF7A70",
	destructiveForeground: "#05261F",
	border: "#1F5A48",
	controlBorder: "#5E9985",
	ring: "#FFC400",
} as const;

// Painel do Bureau e Superadmin (.theme-admin em globals.css): página clara, cartões brancos, destaques verdes. Mude os dois juntos.
export const ADMIN_COLORS = {
	pageBackground: "#F7F9F8",
	pageForeground: "#05261F",
	pageMutedForeground: "#3D5A50",
	pageTint: "#E3EFE9",
	pageBorder: "#BFD6CB",
	pageControlBorder: "#4A7C69",
	pageRing: "#05261F",
	pageDestructive: "#B42318",
	pageDestructiveForeground: "#FFFFFF",
	// Cartão padrão branco com borda fina; quadradinho de ícone em verde claro (= pageTint).
	cardBackground: "#FFFFFF",
	cardBorder: "#D5E3DC",
	iconTile: "#E3EFE9",
	// Destaque escuro (hero): APP_COLORS.card (#0B3A2E). Séries de gráfico sobre branco (amarelo #FFC400 não lê sobre branco).
	chart: ["#0B3A2E", "#2F7A5F", "#9A7200", "#4A7C69", "#3D5A50"],
} as const;

// Estados do app sobre fundo escuro. Sucesso e aviso em amarelo/verde; só o erro usa vermelho.
export const APP_STATE_COLORS: Record<StateName, { bg: string; fg: string; border: string }> = {
	success: { bg: "#0B3A2E", fg: "#FFC400", border: "#5E9985" },
	waiting: { bg: "#3D3200", fg: "#FFD84D", border: "#FFC400" },
	progress: { bg: "#0B3A2E", fg: "#FFFFFF", border: "#5E9985" },
	attention: { bg: "#4A3A00", fg: "#FFC400", border: "#E0A800" },
	danger: { bg: "#3D1717", fg: "#FF9A90", border: "#FF7A70" },
	neutral: { bg: "#0B3A2E", fg: "#D6E6E0", border: "#5E9985" },
};

// Espelho em hex das variáveis CSS de src/app/globals.css. Mude os dois juntos (e tailwind.config.ts).
export const BRAND_COLORS = {
	// Verde profundo: faixa escura, barra lateral, themeColor.
	brand: "#05261F",
	cream: "#F4EAD7",
	ink: "#123029",
	// Verde profundo de ação: texto, link, foco e cartão de saldo.
	primary: "#0A3329",
	primaryForeground: "#FFFFFF",
	// Dourado: fundo do botão principal (texto ctaForeground). Nunca texto sobre fundo claro.
	gold: "#CFA968",
	goldLight: "#E6C891",
	cta: "#CFA968",
	ctaForeground: "#2A1F0A",
	ctaHover: "#E6C891",
	// Extrato: valor em tag (entrada verde claro, gasto vermelho claro, cancelado cinza); sempre com sinal.
	moneyInBg: "#E3EFE9",
	moneyInFg: "#0A3329",
	moneyOutBg: "#FBE4E1",
	moneyOutFg: "#8A1C14",
	moneyVoidBg: "#EEEDEA",
	moneyVoidFg: "#4B5563",
	background: "#FBF8F2",
	foreground: "#123029",
	muted: "#F1ECE1",
	mutedForeground: "#33514A",
	// Borda de controle (campo, caixa de seleção): >= 3:1 no fundo.
	controlBorder: "#7F8F86",
	// Borda de cartão plano: decorativa, sem texto nem controle dentro dela.
	hairline: "#E3DCCD",
	// Fundo de seção alternado com o fundo da página.
	surface: "#F7F2E8",
	// Fundo de tag positiva e de item ativo; texto sobre ele usa brandSoftForeground.
	brandSoft: "#F4EAD7",
	brandSoftForeground: "#05261F",
	focus: "#0A3329",
} as const;

// Neutros (escala do Tailwind gray; 500 escurecido para 4,5:1 sobre surface). 400 só para ícone grande/inativo decorativo, nunca texto de leitura.
export const NEUTRAL_COLORS = {
	50: "#F9FAFB",
	100: "#F3F4F6",
	200: "#E5E7EB",
	300: "#D1D5DB",
	400: "#9CA3AF",
	500: "#666D7A",
	600: "#4B5563",
	700: "#374151",
	800: "#1F2937",
	900: "#111827",
} as const;

export type StateName = "success" | "waiting" | "progress" | "attention" | "danger" | "neutral";

export const STATE_COLORS: Record<StateName, { bg: string; fg: string; border: string }> = {
	success: { bg: "#E3EFE9", fg: "#0A3329", border: "#B9D3C6" },
	waiting: { bg: "#FCEFC7", fg: "#5C4200", border: "#9A7200" },
	progress: { bg: "#E4EEF3", fg: "#17384A", border: "#3B6E8A" },
	attention: { bg: "#FFE6D0", fg: "#7A3300", border: "#B45309" },
	danger: { bg: "#FDE4E1", fg: "#8A1C14", border: "#C53030" },
	neutral: { bg: "#ECEFEE", fg: "#2F3F3E", border: "#6B7F7E" },
};
