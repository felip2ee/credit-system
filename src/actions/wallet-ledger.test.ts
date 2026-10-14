import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";

const state = vi.hoisted(() => ({
  sessionError: null as Error | null,
  role: "bureau_admin" as string,
  listLedger: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  SessionAccessError: class SessionAccessError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  getRequiredSession: vi.fn(async () => {
    if (state.sessionError) throw state.sessionError;
    return { userId: "u1", role: state.role, bureauId: BUREAU_ID, supportSessionId: null };
  }),
}));
vi.mock("@/lib/db/transaction", () => ({
  withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/wallet/queries", () => ({ listLedger: state.listLedger }));

import { SessionAccessError } from "@/lib/auth/session";

import { loadMoreLedgerAction } from "./wallet-ledger";

const NOT_ALLOWED = "Você não tem permissão para ver a carteira.";
const LOAD_FAILED = "Não foi possível carregar o extrato.";
const input = { bureauId: BUREAU_ID, cursor: "10" };

beforeEach(() => {
  vi.clearAllMocks();
  state.sessionError = null;
  state.role = "bureau_admin";
  state.listLedger.mockResolvedValue({ rows: [], nextCursor: null });
});

describe("loadMoreLedgerAction", () => {
  it("returns the next page", async () => {
    expect(await loadMoreLedgerAction(input)).toEqual({ error: null, page: { rows: [], nextCursor: null } });
  });

  it("maps an invalid session to no permission, without logging", async () => {
    state.sessionError = new SessionAccessError("session_required");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await loadMoreLedgerAction(input)).error).toBe(NOT_ALLOWED);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs only name and code when the query throws, and returns a generic error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.listLedger.mockRejectedValue(Object.assign(new Error("secret detail"), { code: "57P01" }));

    expect((await loadMoreLedgerAction(input)).error).toBe(LOAD_FAILED);
    expect(log).toHaveBeenCalledWith(expect.any(String), { name: "Error", code: "57P01" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret detail");
    log.mockRestore();
  });

  it("rejects invalid input", async () => {
    expect((await loadMoreLedgerAction({ bureauId: "x", cursor: "1" })).error).toBe("Dados inválidos.");
  });
});
