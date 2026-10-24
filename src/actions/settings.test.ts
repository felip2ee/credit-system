import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { userId: "u1", role: "operator", bureauId: "b1" } as { userId: string; role: string; bureauId: string | null },
  readSetting: vi.fn(async () => null),
  readSettings: vi.fn(async () => new Map<string, unknown>()),
  upsertSettings: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequiredSession: vi.fn(async () => state.session) }));
vi.mock("@/lib/settings/queries", () => ({
  readSetting: state.readSetting,
  readSettings: state.readSettings,
  upsertSettings: state.upsertSettings,
  deleteSettings: vi.fn(),
}));

import { readAffiliateSettings } from "@/lib/settings/readers";

import { getAiPrompt, getAiPrompts, getScrTermSettings, saveAffiliateSettings } from "./settings";

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

describe("affiliate settings", () => {
  const identity = { userId: "u1", role: "superadmin", bureauId: null };
  const valid = { holdDays: 15, fixed: "2", percent: "1" };

  it("saves hold days and the withdrawal fee, and the reader returns them", async () => {
    state.session = identity;
    await expect(saveAffiliateSettings(valid)).resolves.toEqual({ error: null });

    expect(state.upsertSettings).toHaveBeenCalledWith(
      expect.objectContaining({ role: "superadmin" }),
      [
        { key: "affiliate_commission_hold_days", value: 15 },
        { key: "affiliate_withdrawal_fee", value: { fixed: 2, percent: 1 } },
      ],
      "settings.affiliates",
    );

    state.readSettings.mockResolvedValueOnce(
      new Map<string, unknown>([
        ["affiliate_commission_hold_days", 15],
        ["affiliate_withdrawal_fee", { fixed: 2, percent: 1 }],
      ]),
    );
    await expect(readAffiliateSettings(identity as never)).resolves.toEqual({
      holdDays: 15,
      withdrawalFee: { fixed: "2.00", percent: "1.00" },
    });
  });

  it("reader falls back to 30 days and no fee when nothing is stored", async () => {
    await expect(readAffiliateSettings(identity as never)).resolves.toEqual({
      holdDays: 30,
      withdrawalFee: { fixed: "0.00", percent: "0.00" },
    });
  });

  it.each(["bureau_admin", "operator", "client"])("refuses %s", async (role) => {
    state.session = { userId: "u2", role, bureauId: "b1" };
    const result = await saveAffiliateSettings(valid);
    expect(result.error).toBeTruthy();
    expect(state.upsertSettings).not.toHaveBeenCalled();
  });

  it.each([
    { holdDays: -1, fixed: "0", percent: "0" },
    { holdDays: 366, fixed: "0", percent: "0" },
    { holdDays: 1.5, fixed: "0", percent: "0" },
    { holdDays: 10, fixed: "-1", percent: "0" },
    { holdDays: 10, fixed: "0", percent: "101" },
    { holdDays: 10, fixed: "x", percent: "0" },
  ])("rejects invalid values %j", async (values) => {
    state.session = identity;
    const result = await saveAffiliateSettings(values);
    expect(result.error).toBeTruthy();
    expect(state.upsertSettings).not.toHaveBeenCalled();
  });
});
