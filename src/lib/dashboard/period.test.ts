import { describe, expect, it } from "vitest";

import { parseRevenuePeriod, revenueRange } from "./period";

// 2026-10-26 15:00 em Brasília = 18:00 UTC.
const NOW = Date.UTC(2026, 9, 26, 18, 0, 0);

describe("revenueRange", () => {
  it("hoje cobre o dia de Brasília", () => {
    expect(revenueRange("hoje", NOW)).toEqual({
      start: "2026-10-26T03:00:00.000Z",
      end: "2026-10-27T03:00:00.000Z",
    });
  });

  it("ontem termina onde hoje começa", () => {
    expect(revenueRange("ontem", NOW)).toEqual({
      start: "2026-10-25T03:00:00.000Z",
      end: "2026-10-26T03:00:00.000Z",
    });
  });

  it("mês começa no dia 1; 3m volta dois meses; 9m volta oito", () => {
    expect(revenueRange("mes", NOW).start).toBe("2026-10-01T03:00:00.000Z");
    expect(revenueRange("3m", NOW).start).toBe("2026-08-01T03:00:00.000Z");
    expect(revenueRange("9m", NOW).start).toBe("2026-02-01T03:00:00.000Z");
  });

  it("à 01:00 de Brasília ainda é o dia local, não o dia UTC", () => {
    const lateNight = Date.UTC(2026, 9, 27, 2, 0, 0); // 26/10 23:00 em Brasília
    expect(revenueRange("hoje", lateNight).start).toBe("2026-10-26T03:00:00.000Z");
  });
});

describe("parseRevenuePeriod", () => {
  it("valor desconhecido cai em 'mes'", () => {
    expect(parseRevenuePeriod("xyz")).toBe("mes");
    expect(parseRevenuePeriod(undefined)).toBe("mes");
    expect(parseRevenuePeriod("9m")).toBe("9m");
  });
});
