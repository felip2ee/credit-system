import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  addHolderNote: vi.fn(),
  updateHolder: vi.fn(),
  linkPartner: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "u1", role: "operator", bureauId: "b1" })),
}));
vi.mock("@/lib/db/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/holders/queries", () => ({
  addHolderNote: state.addHolderNote,
  createHolder: vi.fn(),
  linkPartner: state.linkPartner,
  updateHolder: state.updateHolder,
}));

import { addHolderNote, linkPartner, updateHolder } from "./holders";

const UUID = "6f1c2c1e-0b6e-4b8e-9a53-3a0e2f6f4d11";
const CPF = "390.533.447-05";

beforeEach(() => {
  vi.clearAllMocks();
  state.linkPartner.mockResolvedValue({ ok: true, id: "p1" });
});

describe("holder id validation", () => {
  it("addHolderNote returns an error for a non-uuid id", async () => {
    expect(await addHolderNote("abc", "texto")).toEqual({ error: "Titular não encontrado." });
    expect(state.addHolderNote).not.toHaveBeenCalled();
  });

  it("updateHolder returns an error for a non-uuid id", async () => {
    const values = { type: "PF", name: "Maria Souza", document: CPF } as never;
    expect(await updateHolder("abc", values)).toEqual({ error: "Titular não encontrado." });
    expect(state.updateHolder).not.toHaveBeenCalled();
  });

  it("linkPartner returns an error for a non-uuid company id", async () => {
    expect(await linkPartner("abc", { cpf: CPF, name: "Maria Souza" })).toEqual({
      error: "Titular não encontrado.",
    });
    expect(state.linkPartner).not.toHaveBeenCalled();
  });
});

describe("linkPartner", () => {
  it("rejects a percentage above 100", async () => {
    const result = await linkPartner(UUID, { cpf: CPF, name: "Maria Souza", percentage: 101 });
    expect(result.error).toBe("Participação do sócio deve estar entre 0 e 100.");
    expect(state.linkPartner).not.toHaveBeenCalled();
  });

  it("passes the parsed partner to the query", async () => {
    const result = await linkPartner(UUID, { cpf: CPF, name: " Maria Souza ", percentage: 25 });
    expect(result).toEqual({ error: null, id: "p1" });
    expect(state.linkPartner.mock.calls[0][2]).toEqual({
      document: "39053344705",
      name: "Maria Souza",
      percentage: 25,
      role: null,
    });
  });
});
