import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  buildEmail: vi.fn(() => ({ subject: "s", html: "h", text: "t" })),
  sendMail: vi.fn(async () => {}),
  issue: vi.fn(async () => ({ public_token: "tok123" })),
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "00000000-0000-0000-0000-000000000001", role: "admin" })),
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
  resolveScrContact: vi.fn(async () => ({
    type: "PF", document: "39053344705", email: "titular@example.test", name: "Titular",
  })),
  issueSelfScrAuthorization: state.issue,
  getPublicScrAuthorization: vi.fn(),
  confirmPublicScrAuthorization: vi.fn(),
}));
vi.mock("@/lib/email/mailer", () => ({ sendMail: state.sendMail }));
vi.mock("@/lib/email/scr-authorization-email", () => ({ buildScrAuthorizationEmail: state.buildEmail }));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://canonical.example.test" } }));

import { sendScrSelfAuthorization } from "./scr-self";

describe("sendScrSelfAuthorization", () => {
  it("builds the authorization link from the runtime canonical URL, not NEXT_PUBLIC_SITE_URL", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://stale-build-time.example";

    await expect(sendScrSelfAuthorization("scr-1")).resolves.toEqual({ error: null });

    expect(state.buildEmail).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://canonical.example.test/autorizacao-scr/tok123" }),
    );
  });
});
