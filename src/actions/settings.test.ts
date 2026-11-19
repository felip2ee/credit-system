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

vi.mock("@/lib/commission/queries", () => ({
  assertSplitWithin100: vi.fn(),
  lockCommissionSplit: vi.fn(),
  SplitOver100Error: class SplitOver100Error extends Error {},
}));

import { SplitOver100Error } from "@/lib/commission/queries";
import { readAffiliateSettings, readBureauCommissionPct, readPayableRetentionDays } from "@/lib/settings/readers";

import { getAiPrompt, getAiPrompts, getScrTermSettings, saveAffiliateSettings, saveBureauCommissionAction, savePayableRetentionAction } from "./settings";

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

describe("payable retention", () => {
  const identity = { userId: "u1", role: "superadmin", bureauId: null };

  it.each([0, 30, 3650])("saves %s days and audits settings.payable_retention", async (days) => {
    state.session = identity;
    await expect(savePayableRetentionAction({ days })).resolves.toEqual({ error: null });

    expect(state.upsertSettings).toHaveBeenCalledWith(
      expect.objectContaining({ role: "superadmin" }),
      [{ key: "payable_retention_days", value: days }],
      "settings.payable_retention",
      { auditChange: expect.any(Function) },
    );
  });

  it.each([
    [45, 30, { from: 45, to: 30 }],
    [undefined, 30, { from: null, to: 30 }],
    ["abc", 0, { from: null, to: 0 }],
  ])("audit metadata has old and new days (previous %j)", async (previous, days, expected) => {
    state.session = identity;
    await savePayableRetentionAction({ days });

    const options = (state.upsertSettings.mock.calls[0] as unknown[])[3] as {
      auditChange: (previous: Map<string, unknown>) => Record<string, unknown>;
    };
    const map = new Map<string, unknown>(previous === undefined ? [] : [["payable_retention_days", previous]]);
    expect(options.auditChange(map)).toEqual(expected);
  });

  it.each([{ days: 30.5 }, { days: -1 }, { days: 3651 }, { days: "abc" }, { days: "30" }, {}, null])(
    "rejects invalid values %j",
    async (values) => {
      state.session = identity;
      const result = await savePayableRetentionAction(values);
      expect(result.error).toBeTruthy();
      expect(state.upsertSettings).not.toHaveBeenCalled();
    },
  );

  it.each(["bureau_admin", "operator", "client"])("refuses %s", async (role) => {
    state.session = { userId: "u2", role, bureauId: "b1" };
    const result = await savePayableRetentionAction({ days: 30 });
    expect(result.error).toBeTruthy();
    expect(state.upsertSettings).not.toHaveBeenCalled();
  });

  it("reader returns the stored value", async () => {
    state.readSetting.mockResolvedValueOnce(45 as never);
    await expect(readPayableRetentionDays(identity as never)).resolves.toBe(45);
  });

  it.each([null, 30.5, -1, 3651, "30"])("reader falls back to 30 for %j", async (stored) => {
    state.readSetting.mockResolvedValueOnce(stored as never);
    await expect(readPayableRetentionDays(identity as never)).resolves.toBe(30);
  });
});

describe("bureau commission", () => {
  const identity = { userId: "u1", role: "superadmin", bureauId: null };

  it.each([0, 12.5, 20, 99.99])("saves %s%% and audits settings.bureau_commission", async (pct) => {
    state.session = identity;
    await expect(saveBureauCommissionAction({ pct })).resolves.toEqual({ error: null });

    expect(state.upsertSettings).toHaveBeenCalledWith(
      expect.objectContaining({ role: "superadmin" }),
      [{ key: "bureau_commission_pct", value: pct }],
      "settings.bureau_commission",
      {
        auditChange: expect.any(Function),
        beforeWrite: expect.any(Function),
        keepSupportSession: true,
        afterWrite: expect.any(Function),
      },
    );
  });

  it.each([
    [20, 25, { from: 20, to: 25 }],
    [undefined, 25, { from: null, to: 25 }],
  ])("audit metadata has old and new pct (previous %j)", async (previous, pct, expected) => {
    state.session = identity;
    await saveBureauCommissionAction({ pct });

    const options = (state.upsertSettings.mock.calls[0] as unknown[])[3] as {
      auditChange: (previous: Map<string, unknown>) => Record<string, unknown>;
    };
    const map = new Map<string, unknown>(previous === undefined ? [] : [["bureau_commission_pct", previous]]);
    expect(options.auditChange(map)).toEqual(expected);
  });

  it.each([{ pct: -1 }, { pct: 100 }, { pct: 12.345 }, { pct: "20" }, {}, null])("rejects invalid values %j", async (values) => {
    state.session = identity;
    expect((await saveBureauCommissionAction(values)).error).toBeTruthy();
    expect(state.upsertSettings).not.toHaveBeenCalled();
  });

  it.each(["bureau_admin", "operator", "client"])("refuses %s", async (role) => {
    state.session = { userId: "u2", role, bureauId: "b1" };
    expect((await saveBureauCommissionAction({ pct: 20 })).error).toBeTruthy();
    expect(state.upsertSettings).not.toHaveBeenCalled();
  });

  it("refuses the superadmin in a support session", async () => {
    state.session = { ...identity, supportSessionId: "s1" } as typeof identity;
    expect((await saveBureauCommissionAction({ pct: 20 })).error).toBeTruthy();
    expect(state.upsertSettings).not.toHaveBeenCalled();
  });

  it("maps a split above 100 to a pt-BR message", async () => {
    state.session = identity;
    state.upsertSettings.mockRejectedValueOnce(new SplitOver100Error());
    expect((await saveBureauCommissionAction({ pct: 90 })).error).toContain("100%");
  });

  it("reader returns the stored pct or null", async () => {
    state.readSetting.mockResolvedValueOnce(12.5 as never);
    await expect(readBureauCommissionPct(identity as never)).resolves.toBe(12.5);
    for (const stored of [null, -1, 100, "20"]) {
      state.readSetting.mockResolvedValueOnce(stored as never);
      await expect(readBureauCommissionPct(identity as never)).resolves.toBeNull();
    }
  });
});
