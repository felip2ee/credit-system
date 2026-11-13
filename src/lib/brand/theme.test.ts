import { describe, expect, it } from "vitest";
import { resolveBrandTheme } from "./theme";

describe("resolveBrandTheme", () => {
	it.each([
		[undefined, "atual"],
		["", "atual"],
		["atual", "atual"],
		["classico", "classico"],
		[" Classico ", "classico"],
		["clássico", "atual"],
		["roxo", "atual"],
	] as const)("%j -> %s", (raw, expected) => {
		expect(resolveBrandTheme(raw)).toBe(expected);
	});
});
