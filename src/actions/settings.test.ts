import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { userId: "u1", role: "operator", bureauId: "b1" } as { userId: string; role: string; bureauId: string | null },
  readSetting: vi.fn(async () => null),
  readSettings: vi.fn(async () => new Map<string, unknown>()),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequiredSession: vi.fn(async () => state.session) }));
vi.mock("@/lib/settings/queries", () => ({
  readSetting: state.readSetting,
  readSettings: state.readSettings,
  upsertSettings: vi.fn(),
  deleteSettings: vi.fn(),
}));

import { getAiPrompt, getAiPrompts, getScrTermSettings } from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ["getAiPrompt", () => getAiPrompt("pf")],
  ["getAiPrompts", () => getAiPrompts()],
  ["getScrTermSettings", () => getScrTermSettings()],
])("%s", (_name, call) => {
  it("rejects the client role before reading settings", async () => {
    state.session = { userId: "u2", role: "client", bureauId: "b1" };

    await expect(call()).rejects.toThrow();

    expect(state.readSetting).not.toHaveBeenCalled();
    expect(state.readSettings).not.toHaveBeenCalled();
  });

  it.each(["operator", "bureau_admin", "superadmin"])("allows %s", async (role) => {
    state.session = { userId: "u1", role, bureauId: role === "superadmin" ? null : "b1" };

    await expect(call()).resolves.toBeDefined();
  });
});
