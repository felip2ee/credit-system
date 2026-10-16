import { describe, expect, it } from "vitest";

import { requestMeta } from "./request-meta";

const h = (entries: Record<string, string>) => new Headers(entries);

describe("requestMeta drops an invalid ip and truncates user agent", () => {
  it("takes the first x-forwarded-for item", () => {
    expect(requestMeta(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).ip).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(requestMeta(h({ "x-real-ip": "198.51.100.4" })).ip).toBe("198.51.100.4");
  });

  it("turns garbage into null and keeps IPv6", () => {
    expect(requestMeta(h({ "x-forwarded-for": "abc" })).ip).toBeNull();
    expect(requestMeta(h({ "x-forwarded-for": "2001:db8::1" })).ip).toBe("2001:db8::1");
  });

  it("truncates the user agent to 512 characters", () => {
    expect(requestMeta(h({ "user-agent": "u".repeat(600) })).userAgent).toHaveLength(512);
  });

  it("returns nulls without headers", () => {
    expect(requestMeta(h({}))).toEqual({ ip: null, userAgent: null });
  });
});
