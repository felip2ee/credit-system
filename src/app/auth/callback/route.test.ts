import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "@/lib/auth/callback";

describe("legacy auth callback", () => {
  it("keeps redirects on the current origin", () => {
    expect(safeRedirectPath("/portal", "http://localhost:3000")).toBe(
      "http://localhost:3000/portal",
    );
    expect(
      safeRedirectPath("https://attacker.example/steal", "http://localhost:3000"),
    ).toBe("http://localhost:3000/");
  });
});
