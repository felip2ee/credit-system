import { describe, expect, it } from "vitest";

import { brDate, cutoffFromDate, latestPayoutDate } from "./cutoff";

describe("cutoffFromDate", () => {
  it("usa 23:59:59 de São Paulo (UTC-3) em qualquer fuso do navegador", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
        process.env.TZ = tz;
        expect(cutoffFromDate("2026-10-14")).toBe("2026-10-15T02:59:59.000Z");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it("recusa formato inválido", () => {
    expect(cutoffFromDate("")).toBeNull();
    expect(cutoffFromDate("14/10/2026")).toBeNull();
    expect(cutoffFromDate("2026-13-45")).toBeNull();
  });
});

describe("latestPayoutDate", () => {
  it("devolve o último dia inteiro que a retenção já liberou", () => {
    // 25/11 10:00 em São Paulo, 30 dias antes: 26/10 10:00. O corte de 26/10 (23:59:59) passaria; o de 25/10 não.
    expect(latestPayoutDate(30, new Date("2026-11-25T13:00:00Z"))).toBe("2026-10-25");
  });
  it("com prazo 0 devolve ontem, porque o corte de hoje ainda é futuro", () => {
    expect(latestPayoutDate(0, new Date("2026-10-26T15:00:00Z"))).toBe("2026-10-25");
  });
  it("o corte da data devolvida cabe no limite e o do dia seguinte não", () => {
    for (const iso of ["2026-11-25T02:30:00Z", "2026-11-25T03:00:00Z", "2026-11-25T23:59:59Z", "2026-12-01T12:00:00Z"]) {
      const now = new Date(iso);
      const limit = now.getTime() - 30 * 86_400_000;
      const latest = latestPayoutDate(30, now);
      const next = new Date(new Date(`${latest}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
      expect(new Date(cutoffFromDate(latest) as string).getTime()).toBeLessThanOrEqual(limit);
      expect(new Date(cutoffFromDate(next) as string).getTime()).toBeGreaterThan(limit);
    }
  });
});

describe("brDate", () => {
  it("troca AAAA-MM-DD por DD/MM/AAAA", () => expect(brDate("2026-10-25")).toBe("25/10/2026"));
});
