import { describe, expect, it, vi } from "vitest";

const valid = vi.hoisted(() => {
  const value = {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: "/tmp/reino-test-documents",
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
    NODE_ENV: "test",
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

  it("requires an HTTPS Better Auth URL in production", () => {
    expect(() =>
      readConfig({
        ...valid,
        NODE_ENV: "production",
        TRAEFIK_PROXY_CIDR: "10.0.0.0/8",
        BETTER_AUTH_URL: "http://credit-system.example.test",
      }),
    ).toThrow("BETTER_AUTH_URL must use HTTPS outside development and test");
  });

  it("requires one explicit Traefik proxy CIDR in production", () => {
    expect(() =>
      readConfig({ ...valid, NODE_ENV: "production", TRAEFIK_PROXY_CIDR: " " }),
    ).toThrow("TRAEFIK_PROXY_CIDR is required in production");
  });

  it.each(["10.0.0.0", "10.0.0.0/33", "2001:db8::/129", "not-a-cidr/24"])(
    "rejects malformed Traefik proxy CIDR %s",
    (traefikProxyCidr) => {
      expect(() =>
        readConfig({
          ...valid,
          NODE_ENV: "production",
          BETTER_AUTH_URL: "https://credit-system.example.test",
          TRAEFIK_PROXY_CIDR: traefikProxyCidr,
        }),
      ).toThrow("TRAEFIK_PROXY_CIDR must be a valid IPv4 or IPv6 CIDR");
    },
  );

  it("accepts an IPv6 Traefik proxy CIDR in production", () => {
    expect(
      readConfig({
        ...valid,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://credit-system.example.test",
        TRAEFIK_PROXY_CIDR: "2001:db8::/32",
      }).traefikProxyCidr,
    ).toBe("2001:db8::/32");
  });

  it.each(["0", "65536"])("rejects ClamAV port %s outside its range", (port) => {
    expect(() => readConfig({ ...valid, CLAMAV_PORT: port })).toThrow(
      "CLAMAV_PORT must be an integer between 1 and 65535",
    );
  });

  it.each(["1e3", "0x10"])("rejects non-decimal ClamAV port %s", (port) => {
    expect(() => readConfig({ ...valid, CLAMAV_PORT: port })).toThrow(
      "CLAMAV_PORT must be an integer between 1 and 65535",
    );
  });

  it("reads trimmed SMTP settings and defaults the sender", () => {
    const config = readConfig({
      ...valid,
      SMTP_HOST: " smtp.example.test ",
      SMTP_USER: " credit-system ",
      SMTP_PASS: " test-password ",
      SMTP_FROM: " ",
    });

    expect(config.smtpHost).toBe("smtp.example.test");
    expect(config.smtpPort).toBe(465);
    expect(config.smtpSecure).toBe(true);
    expect(config.smtpUser).toBe("credit-system");
    expect(config.smtpPass).toBe("test-password");
    expect(config.smtpFrom).toBe("Rainha do Crédito <credit-system>");
  });

  it.each(["yes", "1", "TRUE"])("rejects non-boolean SMTP_SECURE %s", (secure) => {
    expect(() => readConfig({ ...valid, SMTP_SECURE: secure })).toThrow(
      "SMTP_SECURE must be true or false",
    );
  });

  it.each(["0", "65536"])("rejects SMTP port %s outside its range", (port) => {
    expect(() => readConfig({ ...valid, SMTP_PORT: port })).toThrow(
      "SMTP_PORT must be an integer between 1 and 65535",
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
