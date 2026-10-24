import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({ traefikProxyCidr: "10.0.0.0/8" as string | undefined }));
vi.mock("@/lib/config", () => ({ config: mockConfig }));

import { requestMeta } from "./request-meta";

const h = (entries: Record<string, string>) => new Headers(entries);
const xff = (value: string) => requestMeta(h({ "x-forwarded-for": value })).ip;

describe("requestMeta client ip behind a trusted proxy", () => {
  beforeEach(() => {
    mockConfig.traefikProxyCidr = "10.0.0.0/8";
  });

  it("ignores the client-controlled first x-forwarded-for value", () => {
    expect(xff("6.6.6.6, 203.0.113.7, 10.0.0.5")).toBe("203.0.113.7");
  });

  it("returns a single untrusted value and keeps IPv6", () => {
    expect(xff("203.0.113.7")).toBe("203.0.113.7");
    expect(xff("2001:db8::1")).toBe("2001:db8::1");
  });

  it("returns null when every hop is trusted", () => {
    expect(xff("10.0.0.9, 10.0.0.5")).toBeNull();
  });

  it("returns null for garbage values", () => {
    expect(xff("abc")).toBeNull();
    expect(xff("203.0.113.7, not-an-ip")).toBeNull();
    expect(xff("203.0.113.7, , 10.0.0.5")).toBeNull();
  });

  it("does not trust x-real-ip when a trusted proxy is configured", () => {
    expect(requestMeta(h({ "x-real-ip": "6.6.6.6" })).ip).toBeNull();
  });
});

describe("requestMeta without a configured proxy (local dev)", () => {
  beforeEach(() => {
    mockConfig.traefikProxyCidr = undefined;
  });

  it("takes the last x-forwarded-for item", () => {
    expect(xff("6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("falls back to a valid x-real-ip", () => {
    expect(requestMeta(h({ "x-real-ip": "198.51.100.4" })).ip).toBe("198.51.100.4");
    expect(requestMeta(h({ "x-real-ip": "abc" })).ip).toBeNull();
  });
});

describe("requestMeta user agent", () => {
  it("truncates the user agent to 512 characters", () => {
    expect(requestMeta(h({ "user-agent": "u".repeat(600) })).userAgent).toHaveLength(512);
  });

  it("returns nulls without headers", () => {
    expect(requestMeta(h({}))).toEqual({ ip: null, userAgent: null });
  });
});
