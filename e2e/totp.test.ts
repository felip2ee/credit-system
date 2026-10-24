import { describe, expect, it } from "vitest";

import { totp } from "./totp";

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890". Vectors are 8 digits; we use the last 6.
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
  ])("matches the RFC 6238 vector at %i s", (at, expected) => {
    expect(totp(RFC_SECRET_BASE32, at)).toBe(expected);
  });

  it("decodes base32 without padding and ignores case", () => {
    expect(totp(RFC_SECRET_BASE32.toLowerCase(), 59)).toBe("287082");
  });
});
