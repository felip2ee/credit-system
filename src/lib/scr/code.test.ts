import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ randomInt: vi.fn((min: number, _max: number) => min) }));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: state.randomInt,
}));

import { generateScrCode } from "./code";

describe("generateScrCode", () => {
  beforeEach(() => state.randomInt.mockClear());

  it("scr code uses randomInt and only letters of the alphabet", () => {
    expect(generateScrCode()).toBe("AAAAAA");

    state.randomInt.mockImplementation((_min, max) => max - 1);
    expect(generateScrCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(state.randomInt).toHaveBeenCalledWith(0, 32);
  });
});
