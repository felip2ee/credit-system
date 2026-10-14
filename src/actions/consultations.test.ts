import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { userId: "u1", role: "operator", bureauId: "b1" },
  row: { type: "PF", document: "39053344705", scr_mode: "internal" } as { type: string; document: string; scr_mode: string | null } | undefined,
  hasValidInternalScr: vi.fn(async () => true),
  consultPF: vi.fn(async () => ({ raw: true })),
  execute: vi.fn(async () => ({ status: "completed" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequiredSession: vi.fn(async () => state.session) }));
vi.mock("@/lib/db/transaction", () => ({
  withUserTransaction: vi.fn(async (_i: unknown, fn: (c: unknown) => unknown) =>
    fn({ query: async () => ({ rows: state.row ? [state.row] : [] }) })),
}));
vi.mock("@/lib/deps/client", () => ({ getDepsClient: () => ({ consultPF: state.consultPF, consultPJ: vi.fn() }) }));
vi.mock("@/lib/consultations/service", () => ({ executeConsultation: state.execute }));
vi.mock("@/lib/consultations/queries", () => ({ getConsultation: vi.fn() }));
vi.mock("@/lib/dossiers/queries", () => ({ createDossier: vi.fn(), refreshDossierStatus: vi.fn(async () => {}) }));
vi.mock("@/lib/holders/queries", () => ({ listHolders: vi.fn(), recordHolderEvent: vi.fn() }));
vi.mock("@/lib/scr/queries", () => ({ hasValidInternalScr: state.hasValidInternalScr, upsertScrAuthorization: vi.fn() }));

import { reprocessQuery } from "./consultations";

beforeEach(() => {
  vi.clearAllMocks();
  state.row = { type: "PF", document: "39053344705", scr_mode: "internal" };
  state.hasValidInternalScr.mockResolvedValue(true);
});

describe("reprocessQuery", () => {
  it("rejects an internal-mode consultation without a valid SCR authorization and never calls DEPS", async () => {
    state.hasValidInternalScr.mockResolvedValue(false);

    const result = await reprocessQuery("q1");

    expect(result.error).toBeTruthy();
    expect(state.hasValidInternalScr).toHaveBeenCalledWith(state.session, "39053344705");
    expect(state.consultPF).not.toHaveBeenCalled();
  });

  it("calls DEPS with autorizacaoScr when the internal SCR authorization is valid", async () => {
    const result = await reprocessQuery("q1");

    expect(result).toEqual({ error: null, status: "completed", queryId: "q1" });
    expect(state.consultPF).toHaveBeenCalledWith("39053344705", expect.objectContaining({ autorizacaoScr: true }));
  });

  it("skips the internal SCR gate for deps mode", async () => {
    state.row = { type: "PF", document: "39053344705", scr_mode: "deps" };

    await reprocessQuery("q1");

    expect(state.hasValidInternalScr).not.toHaveBeenCalled();
    expect(state.consultPF).toHaveBeenCalledWith("39053344705", expect.objectContaining({ autorizacaoScr: false }));
  });

  it("rejects a client role", async () => {
    const original = state.session;
    state.session = { userId: "u2", role: "client", bureauId: "b1" };

    await expect(reprocessQuery("q1")).resolves.toEqual({ error: "Não autorizado." });

    state.session = original;
    expect(state.consultPF).not.toHaveBeenCalled();
  });
});
