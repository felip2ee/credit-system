import { describe, expect, it } from "vitest";

import { breakLongToken } from "./fonts";

describe("breakLongToken", () => {
  it("keeps a word of 16 characters or fewer whole", () => {
    expect(breakLongToken("Consultoria")).toEqual(["Consultoria"]);
    expect(breakLongToken("a".repeat(16))).toEqual(["a".repeat(16)]);
  });

  it("splits a long token in parts of at most 16 characters", () => {
    const token = "https://exemplo.com.br/" + "x".repeat(37);
    const parts = breakLongToken(token);
    expect(token).toHaveLength(60);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(16);
    expect(parts.join("")).toBe(token);
  });

  it("returns one empty part for an empty string", () => {
    expect(breakLongToken("")).toEqual([""]);
  });
});
