import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { BRAND_COLORS, NEUTRAL_COLORS, STATE_COLORS } from "./tokens";

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

describe("state colors", () => {
	it.each(Object.entries(STATE_COLORS))("%s text on its background is at least 4.5:1", (_name, s) => {
		expect(contrastRatio(s.fg, s.bg)).toBeGreaterThanOrEqual(4.5);
	});

	it.each(Object.entries(STATE_COLORS))("%s border is at least 3:1 on page background", (_name, s) => {
		expect(contrastRatio(s.border, BRAND_COLORS.background)).toBeGreaterThanOrEqual(3);
	});
});
