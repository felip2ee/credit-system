import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { ADMIN_COLORS, APP_COLORS, APP_STATE_COLORS, BRAND_COLORS, NEUTRAL_COLORS, STATE_COLORS } from "./tokens";

describe("contrastRatio", () => {
	it("returns 21 for black on white", () => {
		expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
	});

	it("is symmetric", () => {
		expect(contrastRatio("#123029", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#123029"), 5);
	});

	it("proves the gold is too light for text on the page background", () => {
		expect(contrastRatio("#CFA968", "#FBF8F2")).toBeLessThan(3);
	});
});

describe("brand colors", () => {
	const c = BRAND_COLORS;

	it("keeps the fixed brand palette", () => {
		expect([c.brand, c.cream, c.ink]).toEqual(["#05261F", "#F4EAD7", "#123029"]);
	});

	it("CTA text on gold is at least 4.5:1 at rest and on hover", () => {
		expect(contrastRatio(c.ctaForeground, c.cta)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(c.ctaForeground, c.ctaHover)).toBeGreaterThanOrEqual(4.5);
	});

	it("dark band and sidebar: cream text and gold accent are at least 4.5:1 on the deep green", () => {
		expect(contrastRatio(c.cream, c.brand)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(c.gold, c.brand)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(c.goldLight, c.brand)).toBeGreaterThanOrEqual(4.5);
	});

	it("muted text on the cream highlight is at least 4.5:1", () => {
		expect(contrastRatio(c.mutedForeground, c.cream)).toBeGreaterThanOrEqual(4.5);
	});

	it("portal text on the main background is at least 7:1", () => {
		expect(contrastRatio(c.foreground, c.background)).toBeGreaterThanOrEqual(7);
		expect(contrastRatio(c.mutedForeground, c.background)).toBeGreaterThanOrEqual(7);
		expect(contrastRatio(c.primary, c.background)).toBeGreaterThanOrEqual(7);
	});

	it("button text on primary is at least 4.5:1", () => {
		expect(contrastRatio(c.primaryForeground, c.primary)).toBeGreaterThanOrEqual(4.5);
	});

	it("main text on background is at least 7:1", () => {
		expect(contrastRatio(c.foreground, c.background)).toBeGreaterThanOrEqual(7);
	});

	it("muted text on background and on muted is at least 4.5:1", () => {
		expect(contrastRatio(c.mutedForeground, c.background)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(c.mutedForeground, c.muted)).toBeGreaterThanOrEqual(4.5);
	});

	it("primary used as text on background is at least 4.5:1", () => {
		expect(contrastRatio(c.primary, c.background)).toBeGreaterThanOrEqual(4.5);
	});

	it("focus ring and control border are at least 3:1 on background", () => {
		expect(contrastRatio(c.focus, c.background)).toBeGreaterThanOrEqual(3);
		expect(contrastRatio(c.controlBorder, c.background)).toBeGreaterThanOrEqual(3);
	});
});

describe("redesign surfaces (PicPay look)", () => {
	const c = BRAND_COLORS;

	it("hero balance card: white bold text on the dark brand tone is at least 4.5:1", () => {
		expect(contrastRatio("#FFFFFF", c.primary)).toBeGreaterThanOrEqual(4.5);
	});

	it("proves the gold cannot be a background for white text", () => {
		expect(contrastRatio("#FFFFFF", c.gold)).toBeLessThan(4.5);
	});

	it("white text on the dark button (#123029) is at least 7:1", () => {
		expect(contrastRatio("#FFFFFF", c.ink)).toBeGreaterThanOrEqual(7);
	});

	it("gray section background keeps text readable", () => {
		expect(contrastRatio(c.foreground, c.surface)).toBeGreaterThanOrEqual(7);
		expect(contrastRatio(c.mutedForeground, c.surface)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(c.primary, c.surface)).toBeGreaterThanOrEqual(4.5);
	});

	it("gray tile (muted) keeps text and the primary icon readable", () => {
		expect(contrastRatio(c.foreground, c.muted)).toBeGreaterThanOrEqual(7);
		expect(contrastRatio(c.primary, c.muted)).toBeGreaterThanOrEqual(4.5);
	});

	it("positive tag and active item text on brandSoft is at least 4.5:1", () => {
		expect(contrastRatio(c.brandSoftForeground, c.brandSoft)).toBeGreaterThanOrEqual(4.5);
	});

	it("secondary neutral text (500) is at least 4.5:1 on white and on the gray section", () => {
		expect(contrastRatio(NEUTRAL_COLORS[500], c.background)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(NEUTRAL_COLORS[500], c.surface)).toBeGreaterThanOrEqual(4.5);
	});

	it("proves neutral 400 is placeholder/inactive only, never reading text", () => {
		expect(contrastRatio(NEUTRAL_COLORS[400], c.background)).toBeLessThan(4.5);
	});

	it("flat card border (hairline) is decorative: below 3:1, so controls must not use it", () => {
		expect(contrastRatio(c.hairline, c.background)).toBeLessThan(3);
	});

	it("active bottom-nav icon (white on primary circle) is at least 3:1", () => {
		expect(contrastRatio("#FFFFFF", c.primary)).toBeGreaterThanOrEqual(3);
	});
});

describe("extrato: tags de valor", () => {
	const c = BRAND_COLORS;

	it.each([
		["entrada", c.moneyInFg, c.moneyInBg],
		["gasto", c.moneyOutFg, c.moneyOutBg],
		["cancelado", c.moneyVoidFg, c.moneyVoidBg],
	])("%s: text on its tag is at least 4.5:1", (_n, fg, bg) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
	});

	it("success tag and entrada tag are the same style", () => {
		expect([STATE_COLORS.success.bg, STATE_COLORS.success.fg]).toEqual([c.moneyInBg, c.moneyInFg]);
	});
});

describe("state colors", () => {
	it.each(Object.entries(STATE_COLORS))("%s text on its background is at least 4.5:1", (_name, s) => {
		expect(contrastRatio(s.fg, s.bg)).toBeGreaterThanOrEqual(4.5);
	});

	it("success text is the single brand green on a light tint", () => {
		expect(STATE_COLORS.success.fg).toBe(BRAND_COLORS.primary);
	});

	// A borda clara do sucesso é decorativa: rótulo e ícone já carregam o sentido.
	it.each(Object.entries(STATE_COLORS).filter(([name]) => name !== "success"))("%s border is at least 3:1 on page background", (_name, s) => {
		expect(contrastRatio(s.border, BRAND_COLORS.background)).toBeGreaterThanOrEqual(3);
	});
});

describe("paleta do app (verde escuro + amarelo)", () => {
	const a = APP_COLORS;

	it.each([
		["texto no fundo", a.foreground, a.background, 7],
		["texto no cartão", a.foreground, a.card, 7],
		["texto secundário no fundo", a.mutedForeground, a.background, 7],
		["texto secundário no cartão", a.mutedForeground, a.card, 4.5],
		["texto do botão primário", a.primaryForeground, a.primary, 4.5],
		["texto do botão primário no hover", a.primaryForeground, a.primaryHover, 4.5],
		["amarelo como texto no fundo", a.primary, a.background, 4.5],
		["amarelo como texto no cartão", a.primary, a.card, 4.5],
		["texto do botão destrutivo", a.destructiveForeground, a.destructive, 4.5],
		["vermelho como texto no cartão", a.destructive, a.card, 4.5],
		["anel de foco no fundo", a.ring, a.background, 3],
		["anel de foco no cartão", a.ring, a.card, 3],
		["borda de controle no cartão", a.controlBorder, a.card, 3],
	])("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it.each(Object.entries(APP_STATE_COLORS))("estado %s: texto no fundo do estado é pelo menos 4,5:1", (_n, s) => {
		expect(contrastRatio(s.fg, s.bg)).toBeGreaterThanOrEqual(4.5);
	});

	it.each(Object.entries(APP_STATE_COLORS))("estado %s: borda é pelo menos 3:1 no fundo do app", (_n, s) => {
		expect(contrastRatio(s.border, a.background)).toBeGreaterThanOrEqual(3);
	});
});

describe("painel admin (página clara, blocos verdes)", () => {
	const p = ADMIN_COLORS;
	const a = APP_COLORS;

	it.each([
		["texto na página", p.pageForeground, p.pageBackground, 7],
		["texto secundário na página", p.pageMutedForeground, p.pageBackground, 7],
		["texto secundário no tom claro", p.pageMutedForeground, p.pageTint, 4.5],
		["texto secundário no botão amarelo", p.pageMutedForeground, a.primary, 4.5],
		["texto no tom claro (hover, campo de busca)", p.pageForeground, p.pageTint, 7],
		["erro na página", p.pageDestructive, p.pageBackground, 4.5],
		["erro no tom claro", p.pageDestructive, p.pageTint, 4.5],
		["texto do botão destrutivo na página", p.pageDestructiveForeground, p.pageDestructive, 4.5],
		["texto do botão amarelo na página", a.primaryForeground, a.primary, 4.5],
		["botão de contorno: texto verde escuro na página", p.pageForeground, p.pageBackground, 7],
		["borda de campo na página", p.pageControlBorder, p.pageBackground, 3],
		["borda de campo no tom claro", p.pageControlBorder, p.pageTint, 3],
		["anel de foco na página", p.pageRing, p.pageBackground, 3],
		["anel de foco amarelo no bloco verde", a.ring, a.card, 3],
		["menu lateral: texto branco", a.foreground, a.background, 7],
		["menu lateral: item ativo", a.primaryForeground, a.primary, 4.5],
		["bloco: texto branco no cartão", a.foreground, a.card, 7],
		["bloco: texto branco no hover de linha", a.foreground, a.cardRaised, 7],
		["bloco: texto secundário no hover de linha", a.mutedForeground, a.cardRaised, 4.5],
		["bloco: amarelo como texto no hover de linha", a.primary, a.cardRaised, 4.5],
	])("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it("prova que amarelo como texto na página clara NÃO tem contraste (por isso text-primary vira verde escuro)", () => {
		expect(contrastRatio(a.primary, p.pageBackground)).toBeLessThan(2);
	});

	it("o destaque verde destaca da página clara (>= 3:1)", () => {
		expect(contrastRatio(a.card, p.pageBackground)).toBeGreaterThanOrEqual(3);
	});
});

describe("painel admin: cartões brancos e hero verde", () => {
	const p = ADMIN_COLORS;
	const a = APP_COLORS;

	const rows: [string, string, string, number][] = [
		["texto verde escuro no cartão branco", p.pageForeground, p.cardBackground, 7],
		["texto secundário no cartão branco", p.pageMutedForeground, p.cardBackground, 7],
		["erro no cartão branco", p.pageDestructive, p.cardBackground, 4.5],
		["borda de campo no cartão branco", p.pageControlBorder, p.cardBackground, 3],
		["anel de foco no cartão branco", p.pageRing, p.cardBackground, 3],
		["ícone verde escuro no quadradinho claro", p.pageForeground, p.iconTile, 7],
		["texto secundário no quadradinho claro", p.pageMutedForeground, p.iconTile, 4.5],
		["segmented: texto secundário no contêiner branco", p.pageMutedForeground, p.cardBackground, 4.5],
		["segmented: opção ativa (verde escuro no amarelo)", a.primaryForeground, a.primary, 4.5],
		["hero: número branco no verde bloco", a.foreground, a.card, 7],
		["hero: rótulo amarelo no verde bloco", a.primary, a.card, 4.5],
		["hero: texto secundário no verde bloco", a.mutedForeground, a.card, 4.5],
		["hero: foco amarelo no verde bloco", a.ring, a.card, 3],
		...p.chart.map((hex, i): [string, string, string, number] => [`série ${i + 1} do gráfico no cartão branco (gráfico >= 3:1)`, hex, p.cardBackground, 3]),
		["contorno âmbar da barra amarela no cartão branco", p.chart[2], p.cardBackground, 3],
	];

	it.each(rows)("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it("estados claros (STATE_COLORS) leem no cartão branco: borda >= 3:1, exceto a de sucesso (decorativa)", () => {
		for (const [name, s] of Object.entries(STATE_COLORS)) {
			expect(contrastRatio(s.fg, s.bg), name).toBeGreaterThanOrEqual(4.5);
			if (name !== "success") expect(contrastRatio(s.border, p.cardBackground), name).toBeGreaterThanOrEqual(3);
		}
	});

	it("a borda fina do cartão é decorativa (< 3:1): nunca usar em campo", () => {
		expect(contrastRatio(p.cardBorder, p.cardBackground)).toBeLessThan(3);
	});

	it("prova que o amarelo não lê sobre o cartão branco (por isso gráfico usa verde e âmbar escuro)", () => {
		expect(contrastRatio(a.primary, p.cardBackground)).toBeLessThan(2);
	});

	it("o cartão branco destaca da página #F7F9F8 só pela borda: página e cartão são quase iguais", () => {
		expect(contrastRatio(p.cardBackground, p.pageBackground)).toBeLessThan(1.2);
	});
});

describe("landing pública (Editorial claro)", () => {
	const L = {
		green: "#05261F",
		greenAlt: "#0B3A2E",
		yellow: "#FFC400",
		yellowHover: "#FFD433",
		offwhite: "#F7F9F8",
		white: "#FFFFFF",
		muted: "#3D5A50",
		soft: "#D9E6E1",
		border: "#D5E3DC",
		mint: "#E3EFE9",
	};

	it("os hex do teste são os tokens de .landing em globals.css", () => {
		const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8").toLowerCase();
		const block = css.slice(css.indexOf(".landing {"), css.indexOf(".landing :focus-visible"));
		for (const hex of Object.values(L)) expect(block, hex).toContain(hex.toLowerCase());
	});

	it.each([
		["branco no verde escuro (topo, hero, cartão empresarial)", L.white, L.green, 7],
		["texto suave no verde escuro", L.soft, L.green, 7],
		["amarelo como texto no verde escuro", L.yellow, L.green, 7],
		["branco na faixa do diferencial", L.white, L.greenAlt, 7],
		["texto suave na faixa do diferencial", L.soft, L.greenAlt, 7],
		["amarelo na faixa do diferencial", L.yellow, L.greenAlt, 7],
		["verde escuro na página off-white", L.green, L.offwhite, 7],
		["texto secundário na página off-white", L.muted, L.offwhite, 7],
		["verde escuro no cartão branco", L.green, L.white, 7],
		["texto secundário no cartão branco", L.muted, L.white, 7],
		["texto secundário no cartão menta", L.muted, L.mint, 4.5],
		["verde escuro no cartão menta e no ícone", L.green, L.mint, 7],
		["verde escuro no botão amarelo", L.green, L.yellow, 7],
		["verde escuro no botão amarelo em hover", L.green, L.yellowHover, 7],
		["amarelo no botão verde escuro da faixa final", L.yellow, L.green, 7],
		["amarelo no botão verde escuro em hover", L.yellow, L.greenAlt, 7],
		["etiqueta amarela no cartão verde escuro (ícone e rótulo)", L.yellow, L.green, 4.5],
		["selo PDF: amarelo sobre verde escuro", L.yellow, L.green, 4.5],
		["foco: contorno verde escuro na página off-white", L.green, L.offwhite, 3],
		["foco: contorno verde escuro no cartão branco", L.green, L.white, 3],
		["foco: contorno verde escuro na faixa amarela", L.green, L.yellow, 3],
		["foco: halo amarelo no hero verde escuro", L.yellow, L.green, 3],
		["foco: halo amarelo na faixa do diferencial", L.yellow, L.greenAlt, 3],
		["foco: halo amarelo sobre o cartão menta/branco não é necessário (contorno verde lê)", L.green, L.mint, 3],
	])("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it("prova que o amarelo NÃO lê como texto sobre fundo claro (por isso vira #05261F)", () => {
		expect(contrastRatio(L.yellow, L.offwhite)).toBeLessThan(2);
		expect(contrastRatio(L.yellow, L.white)).toBeLessThan(2);
	});

	it("a borda do cartão é decorativa (< 3:1): o cartão não depende dela", () => {
		expect(contrastRatio(L.border, L.white)).toBeLessThan(3);
	});
});
