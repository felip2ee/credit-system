import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { userId: "u1", role: "operator", bureauId: "b1" } as { userId: string; role: string; bureauId: string },
  scr: { id: "scr-1", document: "39053344705", type: "PF", name: "Titular", email: null, consultation_id: "q1", holder_id: "h1", status: "pending" } as Record<string, unknown> | null,
  consultPF: vi.fn(async () => ({ raw: true })),
  consultPJ: vi.fn(async () => ({ raw: true })),
  getScrAuthorization: vi.fn(),
  execute: vi.fn(async () => ({ status: "completed" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequiredSession: vi.fn(async () => state.session) }));
vi.mock("@/lib/db/transaction", () => ({
  withUserTransaction: vi.fn(async (_i: unknown, fn: (c: unknown) => unknown) =>
    fn({ query: async () => ({ rows: [{ scr_mode: "internal", dossier_id: "d1" }] }) })),
}));
vi.mock("@/lib/deps/client", () => ({ getDepsClient: () => ({ consultPF: state.consultPF, consultPJ: state.consultPJ }) }));
vi.mock("@/lib/consultations/service", () => ({ executeConsultation: state.execute }));
vi.mock("@/lib/scr/queries", () => ({
  getScrAuthorization: state.getScrAuthorization,
  getScrByConsultation: vi.fn(async () => ({ id: "scr-1", document: "39053344705" })),
  markScrPending: vi.fn(async () => {}),
  authorizeScr: vi.fn(async () => {}),
}));

import { retryScrByQuery, verifyScr } from "./scr";

beforeEach(() => {
  vi.clearAllMocks();
  state.session = { userId: "u1", role: "operator", bureauId: "b1" };
  state.getScrAuthorization.mockImplementation(async () => state.scr);
});

describe("verifyScr", () => {
  it("sends only the stored SCR document to DEPS", async () => {
    // @ts-expect-error a legacy caller may still pass a second argument
    await verifyScr("scr-1", "11122233396");

    expect(state.consultPF).toHaveBeenCalledTimes(1);
    expect(state.consultPF).toHaveBeenCalledWith("39053344705", expect.anything());
  });

  it("rejects a client role before any query or DEPS call", async () => {
    state.session = { userId: "u2", role: "client", bureauId: "b1" };

    await expect(verifyScr("scr-1")).resolves.toMatchObject({ status: "not_authorized" });

    expect(state.getScrAuthorization).not.toHaveBeenCalled();
    expect(state.consultPF).not.toHaveBeenCalled();
  });

  it("returns not_authorized when RLS hides the SCR row", async () => {
    state.scr = null;

    await expect(verifyScr("scr-x")).resolves.toMatchObject({ status: "not_authorized" });

    expect(state.consultPF).not.toHaveBeenCalled();
    state.scr = { id: "scr-1", document: "39053344705", type: "PF", name: "Titular", email: null, consultation_id: "q1", holder_id: "h1", status: "pending" };
  });
});

describe("retryScrByQuery", () => {
  it("retries through the stored SCR row", async () => {
    await retryScrByQuery("q1");

    expect(state.consultPF).toHaveBeenCalledWith("39053344705", expect.anything());
  });
});
