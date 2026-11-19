import { describe, expect, it } from "vitest";
import { opinionFromAiReport } from "./opinion-from-report";

const row = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  aptitude_status: "apt_with_caveats",
  full_report: { classificacao_perfil: "Bom" },
  executive_summary: "Resumo",
  positive_points: [{ title: "A", description: "a" }],
  risk_points: [{ title: "B", description: "b", severity: "high" }],
  action_plan: [{ step: "1", description: "c" }],
  suggested_limit: "1500.50",
  suggested_limit_notes: "Nota",
  model_used: "m",
  report_markdown: "# Parecer",
  ...over,
});

describe("opinionFromAiReport", () => {
  it("fills every field and converts the numeric limit", () => {
    expect(opinionFromAiReport(row())).toEqual({
      aptitude: "apt_with_caveats",
      classificacao: "Bom",
      resumo: "Resumo",
      pontosFortes: [{ title: "A", description: "a" }],
      pontosAtencao: [{ title: "B", description: "b", severity: "high" }],
      planoAcao: [{ step: "1", description: "c" }],
      limiteSugerido: 1500.5,
      limiteNotas: "Nota",
      modelo: "m",
      relatorioMarkdown: "# Parecer",
    });
  });

  it("returns null for a missing or not completed report", () => {
    expect(opinionFromAiReport(null)).toBeNull();
    expect(opinionFromAiReport(row({ status: "failed" }))).toBeNull();
  });

  it("defaults null lists and limit", () => {
    const o = opinionFromAiReport(row({ positive_points: null, risk_points: null, action_plan: null, suggested_limit: null, full_report: null }));
    expect(o).toMatchObject({ pontosFortes: [], pontosAtencao: [], planoAcao: [], limiteSugerido: null, classificacao: null });
  });
});
