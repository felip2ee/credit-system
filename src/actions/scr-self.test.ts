import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  issue: vi.fn(async (): Promise<{ ok: true } | { ok: false; reason: string }> => ({ ok: true })),
  resolve: vi.fn(async () => ({
    type: "PF", document: "39053344705", email: "titular@example.test", name: "Titular",
  }) as Record<string, string> | null),
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "00000000-0000-0000-0000-000000000001", role: "operator", bureauId: "00000000-0000-0000-0000-0000000000b1" })),
}));
vi.mock("@/actions/settings", () => ({
  getScrTermSettings: vi.fn(async () => ({
    authorizedName: "Rainha", authorizedDocument: "", institutionName: "Rainha", city: "SP",
  })),
}));
vi.mock("@/lib/scr/consent-term", () => ({
  buildScrConsentTerm: vi.fn(() => ({ fullText: "consent" })),
}));
vi.mock("@/lib/scr/queries", () => ({
  resolveScrContact: state.resolve,
  issueSelfScrAuthorization: state.issue,
  getPublicScrAuthorization: vi.fn(),
  confirmPublicScrAuthorization: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://canonical.example.test/" } }));

import { sendScrSelfAuthorization } from "./scr-self";

describe("sendScrSelfAuthorization", () => {
  beforeEach(() => {
    state.issue.mockClear();
    state.issue.mockResolvedValue({ ok: true });
  });

  it("passes the runtime canonical URL, not NEXT_PUBLIC_SITE_URL, to the enqueue step", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://stale-build-time.example";

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({ error: null });

    expect(state.issue).toHaveBeenCalledWith(
      expect.anything(),
      "scr-1",
      expect.objectContaining({
        notification: {
          recipient: "titular@example.test",
          clientName: "Titular",
          authorizedName: "Rainha",
          siteUrl: "https://canonical.example.test",
        },
      }),
    );
  });

  it("never puts the document in the notification params when the record has no name", async () => {
    state.resolve.mockResolvedValueOnce({ type: "PF", document: "39053344705", email: "titular@example.test" });

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({ error: null });

    const input = (state.issue.mock.calls[0] as unknown[])[2] as { notification: { clientName: string } };
    expect(input.notification.clientName).toBe("cliente");
    expect(JSON.stringify(input.notification)).not.toContain("39053344705");
  });

  it("refuses an invalid recipient before issuing a code", async () => {
    state.resolve.mockResolvedValueOnce({ type: "PF", document: "39053344705", email: "sem-arroba", name: "Titular" });

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({
      error: "Titular sem e-mail válido — cadastre o e-mail antes de enviar.",
    });
    expect(state.issue).not.toHaveBeenCalled();
  });

  it("maps invalid_recipient from the queue to the e-mail message", async () => {
    state.issue.mockResolvedValueOnce({ ok: false, reason: "invalid_recipient" });

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({
      error: "Titular sem e-mail válido — cadastre o e-mail antes de enviar.",
    });
  });

  it("returns a generic error when the enqueue fails for another reason", async () => {
    state.issue.mockResolvedValueOnce({ ok: false, reason: "template_not_found" });

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({
      error: "Não foi possível enfileirar o e-mail.",
    });
  });

  it("returns not found when the SCR record is not visible", async () => {
    state.issue.mockResolvedValueOnce({ ok: false, reason: "not_found" });

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({ error: "Registro SCR não encontrado." });
  });
});
