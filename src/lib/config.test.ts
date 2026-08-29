import { describe, expect, it, vi } from "vitest";

const valid = vi.hoisted(() => {
  const value = {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: "D:/credit-system/.data/documents",
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
  };
  Object.assign(process.env, value);
  return value;
});

import { readConfig } from "./config";

describe("readConfig", () => {
  it("rejects a missing required value", () => {
    expect(() => readConfig({ ...valid, DATABASE_URL: " " })).toThrow(
      "DATABASE_URL is required",
    );
  });

  it("rejects an auth secret shorter than 32 characters", () => {
    expect(() =>
      readConfig({ ...valid, BETTER_AUTH_SECRET: "too-short" }),
    ).toThrow("BETTER_AUTH_SECRET must be at least 32 characters");
  });

  it("rejects a document root that is not absolute", () => {
    expect(() =>
      readConfig({ ...valid, DOCUMENT_ROOT: "documents" }),
    ).toThrow("DOCUMENT_ROOT must be an absolute path");
  });

  it("rejects malformed URLs", () => {
    expect(() =>
      readConfig({ ...valid, BETTER_AUTH_URL: "not a URL" }),
    ).toThrow("BETTER_AUTH_URL must be a valid URL");
  });

  it.each(["0", "65536"])("rejects ClamAV port %s outside its range", (port) => {
    expect(() => readConfig({ ...valid, CLAMAV_PORT: port })).toThrow(
      "CLAMAV_PORT must be an integer between 1 and 65535",
    );
  });

  it("trims values and returns a frozen configuration", () => {
    const config = readConfig({
      ...valid,
      CLAMAV_HOST: " localhost ",
    });

    expect(config.clamavHost).toBe("localhost");
    expect(Object.isFrozen(config)).toBe(true);
  });
});
