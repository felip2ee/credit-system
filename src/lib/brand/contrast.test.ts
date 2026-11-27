import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { BRAND_COLORS, NEUTRAL_COLORS, STATE_COLORS, THEME_COLORS } from "./tokens";

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

// Tema único (página creme, cartões brancos, blocos de verde profundo, dourado de destaque).
describe("tema: página creme, cartões brancos", () => {
	const b = BRAND_COLORS;
	const k = THEME_COLORS;

	it.each([
		["texto no fundo", b.foreground, b.background, 7],
		["texto no cartão branco", b.foreground, k.card, 7],
		["texto secundário no fundo", b.mutedForeground, b.background, 7],
		["texto secundário no cartão branco", b.mutedForeground, k.card, 7],
		["texto secundário no creme (muted, accent, secondary)", b.mutedForeground, b.cream, 4.5],
		["texto secundário no muted", b.mutedForeground, b.muted, 4.5],
		["texto no creme", b.foreground, b.cream, 7],
		["texto na seção alternada", b.foreground, b.surface, 7],
		["primário verde como link no fundo", b.primary, b.background, 7],
		["primário verde como link no cartão", b.primary, k.card, 7],
		["primário verde como link no creme", b.primary, b.cream, 7],
		["texto branco no botão primário", b.primaryForeground, b.primary, 7],
		["texto branco no botão primário em hover", b.primaryForeground, k.primaryHover, 7],
		["texto do botão dourado (CTA)", b.ctaForeground, b.cta, 4.5],
		["texto do botão dourado em hover", b.ctaForeground, b.ctaHover, 4.5],
		["texto do botão destrutivo", b.primaryForeground, k.destructive, 4.5],
		["erro como texto no fundo", k.destructive, b.background, 4.5],
		["erro como texto no cartão", k.destructive, k.card, 4.5],
		["erro como texto no creme (accent, hover de linha)", k.destructive, b.cream, 4.5],
		["texto na tag de item ativo", b.brandSoftForeground, b.brandSoft, 4.5],
		["foco no fundo", b.focus, b.background, 3],
		["foco no cartão", b.focus, k.card, 3],
		["borda de controle no fundo", k.controlBorder, b.background, 3],
		["borda de controle no cartão", k.controlBorder, k.card, 3],
		["borda de controle no creme", k.controlBorder, b.cream, 3],
		["borda de controle no muted", k.controlBorder, b.muted, 3],
		["hero: texto branco no verde", "#FFFFFF", b.primary, 7],
		["botão escuro: texto branco no ink", "#FFFFFF", b.ink, 7],
		...k.chart.map((hex, i): [string, string, string, number] => [`série ${i + 1} do gráfico no cartão branco`, hex, k.card, 3]),
		...k.chart.map((hex, i): [string, string, string, number] => [`série ${i + 1} do gráfico no fundo creme`, hex, b.background, 3]),
	])("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it.each(Object.entries(STATE_COLORS))("estado %s: texto 4,5:1 no tom e no creme; borda >= 3:1 no cartão (exceto sucesso, decorativa)", (name, s) => {
		expect(contrastRatio(s.fg, s.bg)).toBeGreaterThanOrEqual(4.5);
		if (name !== "success") expect(contrastRatio(s.border, k.card)).toBeGreaterThanOrEqual(3);
	});

	it("o cartão branco destaca da página creme só pela borda: página e cartão são quase iguais (< 1,2:1)", () => {
		expect(contrastRatio(k.card, b.background)).toBeLessThan(1.2);
	});

	it("prova que o dourado NÃO lê como texto no creme nem no branco (por isso só fundo de botão e faixa escura)", () => {
		expect(contrastRatio(b.gold, b.background)).toBeLessThan(3);
		expect(contrastRatio(b.gold, k.card)).toBeLessThan(3);
	});
});

describe("tema: blocos de verde profundo (menu, hero, botão escuro)", () => {
	const d = THEME_COLORS.dark;

	it.each([
		["texto branco no fundo", d.foreground, d.background, 7],
		["texto branco no cartão", d.foreground, d.card, 7],
		["texto secundário no fundo", d.mutedForeground, d.background, 7],
		["texto secundário no cartão", d.mutedForeground, d.card, 7],
		["texto secundário no hover de linha", d.mutedForeground, d.accent, 4.5],
		["branco no hover de linha", d.foreground, d.accent, 7],
		["dourado como texto no fundo", d.primary, d.background, 7],
		["dourado como texto no cartão", d.primary, d.card, 4.5],
		["dourado como texto no hover de linha", d.primary, d.accent, 4.5],
		["dourado claro como texto no cartão", d.primaryHover, d.card, 4.5],
		["texto do botão dourado", d.primaryForeground, d.primary, 4.5],
		["texto do botão dourado em hover", d.primaryForeground, d.primaryHover, 4.5],
		["item ativo do menu: verde escuro no dourado", d.background, d.primary, 4.5],
		["erro como texto no cartão", d.destructive, d.card, 4.5],
		["texto do botão destrutivo", d.destructiveForeground, d.destructive, 4.5],
		["anel de foco dourado no cartão", d.primary, d.card, 3],
		["borda de controle no cartão", d.controlBorder, d.card, 3],
		["botão escuro (ink) em verde profundo: dourado como borda", d.primary, BRAND_COLORS.ink, 3],
	])("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it("o hero verde destaca da página creme (>= 3:1)", () => {
		expect(contrastRatio(d.card, BRAND_COLORS.background)).toBeGreaterThanOrEqual(3);
	});
});

describe("tema: landing pública", () => {
	const L = THEME_COLORS.landing;

	it("os hex do teste são os tokens de .landing em globals.css", () => {
		const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8").toLowerCase();
		const block = css.slice(css.indexOf(".landing {"), css.indexOf(".landing :focus-visible"));
		for (const hex of Object.values(L)) expect(block, hex).toContain(hex.toLowerCase());
	});

	it.each([
		["branco no verde escuro", L.white, L.green, 7],
		["texto suave no verde escuro", L.soft, L.green, 7],
		["dourado como texto no verde escuro", L.yellow, L.green, 7],
		["branco na faixa do diferencial", L.white, L.greenAlt, 7],
		["texto suave na faixa do diferencial", L.soft, L.greenAlt, 7],
		["dourado na faixa do diferencial", L.yellow, L.greenAlt, 4.5],
		["verde escuro na página creme", L.green, L.offwhite, 7],
		["texto secundário na página creme", L.muted, L.offwhite, 7],
		["verde escuro no cartão branco", L.green, L.white, 7],
		["texto secundário no cartão branco", L.muted, L.white, 7],
		["texto secundário no cartão creme", L.muted, L.mint, 4.5],
		["verde escuro no cartão creme e no ícone", L.green, L.mint, 7],
		["verde escuro no botão dourado", L.green, L.yellow, 7],
		["verde escuro no botão dourado em hover", L.green, L.yellowHover, 7],
		["dourado no botão verde escuro da faixa final", L.yellow, L.green, 7],
		["dourado no botão verde escuro em hover", L.yellow, L.greenAlt, 4.5],
		["foco: contorno verde escuro na página creme", L.green, L.offwhite, 3],
		["foco: contorno verde escuro na faixa dourada", L.green, L.yellow, 3],
		["foco: halo dourado no hero verde escuro", L.yellow, L.green, 3],
		["foco: contorno verde escuro no cartão branco", L.green, L.white, 3],
		["foco: halo dourado na faixa do diferencial", L.yellow, L.greenAlt, 3],
		["foco: sobre o cartão creme o contorno verde lê, sem halo", L.green, L.mint, 3],
		["etiqueta dourada no cartão verde escuro (ícone e rótulo)", L.yellow, L.green, 4.5],
		["selo PDF: dourado sobre verde escuro", L.yellow, L.green, 4.5],
	])("%s: pelo menos %s:1", (_n, fg, bg, min) => {
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
	});

	it("a borda do cartão é decorativa (< 3:1): o cartão não depende dela", () => {
		expect(contrastRatio(L.border, L.white)).toBeLessThan(3);
	});

	it("prova que o dourado NÃO lê como texto sobre fundo claro", () => {
		expect(contrastRatio(L.yellow, L.offwhite)).toBeLessThan(3);
		expect(contrastRatio(L.yellow, L.white)).toBeLessThan(3);
	});
});

describe("tema: hex ↔ CSS", () => {
	const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

	function hsl(hex: string): string {
		const n = parseInt(hex.slice(1), 16);
		const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
		const mx = Math.max(r, g, b);
		const mn = Math.min(r, g, b);
		const d = mx - mn;
		const l = (mx + mn) / 2;
		const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
		const h = d === 0 ? 0 : (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
		return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
	}

	const pairs: [string, string][] = [
		["--background", BRAND_COLORS.background],
		["--foreground", BRAND_COLORS.foreground],
		["--primary", BRAND_COLORS.primary],
		["--primary-hover", THEME_COLORS.primaryHover],
		["--cta", BRAND_COLORS.cta],
		["--cta-foreground", BRAND_COLORS.ctaForeground],
		["--cta-hover", BRAND_COLORS.ctaHover],
		["--muted", BRAND_COLORS.muted],
		["--muted-foreground", BRAND_COLORS.mutedForeground],
		["--accent", BRAND_COLORS.cream],
		["--destructive", THEME_COLORS.destructive],
		["--border", BRAND_COLORS.hairline],
		["--input", THEME_COLORS.controlBorder],
		["--surface", BRAND_COLORS.surface],
		...THEME_COLORS.chart.map((hex, i): [string, string] => [`--chart-${i + 1}`, hex]),
		["--primary", THEME_COLORS.dark.primary],
		["--primary-foreground", THEME_COLORS.dark.primaryForeground],
		["--primary-hover", THEME_COLORS.dark.primaryHover],
		["--card", THEME_COLORS.dark.card],
		["--muted-foreground", THEME_COLORS.dark.mutedForeground],
		["--accent", THEME_COLORS.dark.accent],
		["--input", THEME_COLORS.dark.controlBorder],
		["--destructive", THEME_COLORS.dark.destructive],
	];

	it.each(pairs)("%s = %s", (name, hex) => {
		expect(css).toContain(`${name}: ${hsl(hex)};`);
	});
});
