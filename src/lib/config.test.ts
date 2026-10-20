import { describe, expect, it, vi } from "vitest";

const valid = vi.hoisted(() => {
  const value = {
    DATABASE_URL: "postgres://app_runtime:test@localhost:54329/credit_system_test",
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

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ASAAS_WEBHOOK_TOKEN_EXAMPLE,
  readAsaasConfig,
  readConfig,
  NOTIFICATIONS_DISPATCH_SECRET_EXAMPLE,
  readDispatchDatabaseUrl,
  readNfseConfig,
  readNotificationsDispatchSecret,
  readWebhookDatabaseUrl,
  readWhatsappConfig,
} from "./config";

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

describe("readAsaasConfig", () => {
  const webhookToken = "w".repeat(32);
  const asaas = {
    ASAAS_DRIVER: "asaas",
    ASAAS_API_KEY: "test-api-key",
    ASAAS_API_BASE_URL: "https://api-sandbox.asaas.example",
    ASAAS_CUSTOMER_ID: "cus_test",
    ASAAS_WEBHOOK_TOKEN: webhookToken,
  };

  it("fails without a driver, with no silent fallback", () => {
    expect(() => readAsaasConfig({ ASAAS_WEBHOOK_TOKEN: webhookToken })).toThrow(
      "ASAAS_DRIVER is required",
    );
  });

  it("rejects an unknown driver", () => {
    expect(() => readAsaasConfig({ ...asaas, ASAAS_DRIVER: "mock" })).toThrow(
      "ASAAS_DRIVER must be asaas or fake",
    );
  });

  it("rejects the fake driver in production", () => {
    expect(() =>
      readAsaasConfig({ ASAAS_DRIVER: "fake", ASAAS_WEBHOOK_TOKEN: webhookToken, NODE_ENV: "production" }),
    ).toThrow("ASAAS_DRIVER=fake is not allowed in production");
  });

  it("accepts the fake driver outside production", () => {
    expect(readAsaasConfig({ ASAAS_DRIVER: "fake", ASAAS_WEBHOOK_TOKEN: webhookToken, NODE_ENV: "test" })).toEqual({
      driver: "fake",
      webhookToken,
    });
  });

  it.each(["ASAAS_API_KEY", "ASAAS_API_BASE_URL", "ASAAS_CUSTOMER_ID", "ASAAS_WEBHOOK_TOKEN"])(
    "requires %s for the asaas driver",
    (name) => {
      expect(() => readAsaasConfig({ ...asaas, [name]: " " })).toThrow(`${name} is required`);
    },
  );

  it("rejects a base URL that is not a URL", () => {
    expect(() => readAsaasConfig({ ...asaas, ASAAS_API_BASE_URL: "not a URL" })).toThrow(
      "ASAAS_API_BASE_URL must be a valid URL",
    );
  });

  it.each(["http://api.asaas.example", "ftp://api.asaas.example", "file:///etc/passwd"])(
    "rejects the non-https base URL %s",
    (ASAAS_API_BASE_URL) => {
      expect(() => readAsaasConfig({ ...asaas, ASAAS_API_BASE_URL })).toThrow(
        "ASAAS_API_BASE_URL must use https",
      );
    },
  );

  it("accepts the fake driver without a base URL", () => {
    expect(() =>
      readAsaasConfig({ ASAAS_DRIVER: "fake", ASAAS_WEBHOOK_TOKEN: webhookToken, ASAAS_API_BASE_URL: "http://x.test" }),
    ).not.toThrow();
  });

  it("rejects a webhook token shorter than 32 characters", () => {
    expect(() => readAsaasConfig({ ...asaas, ASAAS_WEBHOOK_TOKEN: "short" })).toThrow(
      "ASAAS_WEBHOOK_TOKEN must be at least 32 characters",
    );
  });

  it("returns the asaas settings", () => {
    expect(readAsaasConfig(asaas)).toEqual({
      driver: "asaas",
      apiKey: "test-api-key",
      baseUrl: "https://api-sandbox.asaas.example",
      customerId: "cus_test",
      webhookToken,
    });
  });
});

describe("readAsaasConfig webhook token placeholder", () => {
  const asaas = {
    ASAAS_DRIVER: "asaas",
    ASAAS_API_KEY: "test-api-key",
    ASAAS_API_BASE_URL: "https://api-sandbox.asaas.example",
    ASAAS_CUSTOMER_ID: "cus_test",
    ASAAS_WEBHOOK_TOKEN: ASAAS_WEBHOOK_TOKEN_EXAMPLE,
  };

  it("matches the value shipped in .env.example", () => {
    const example = readFileSync(path.resolve(process.cwd(), ".env.example"), "utf8");
    expect(example).toContain(`ASAAS_WEBHOOK_TOKEN=${ASAAS_WEBHOOK_TOKEN_EXAMPLE}\n`);
  });

  it("rejects the example token for the asaas driver", () => {
    expect(() => readAsaasConfig(asaas)).toThrow("ASAAS_WEBHOOK_TOKEN must not be the .env.example placeholder");
  });

  it("rejects the example token in production", () => {
    expect(() => readAsaasConfig({ ...asaas, NODE_ENV: "production" })).toThrow(
      "ASAAS_WEBHOOK_TOKEN must not be the .env.example placeholder",
    );
  });

  it("accepts the example token for the fake driver outside production", () => {
    expect(
      readAsaasConfig({ ASAAS_DRIVER: "fake", ASAAS_WEBHOOK_TOKEN: ASAAS_WEBHOOK_TOKEN_EXAMPLE, NODE_ENV: "development" }),
    ).toEqual({ driver: "fake", webhookToken: ASAAS_WEBHOOK_TOKEN_EXAMPLE });
  });
});

describe("readWebhookDatabaseUrl", () => {
  it("requires a valid URL", () => {
    expect(() => readWebhookDatabaseUrl({})).toThrow("DATABASE_WEBHOOK_URL is required");
    expect(() => readWebhookDatabaseUrl({ DATABASE_WEBHOOK_URL: "not a URL" })).toThrow(
      "DATABASE_WEBHOOK_URL must be a valid URL",
    );
    expect(readWebhookDatabaseUrl({ DATABASE_WEBHOOK_URL: "postgres://app_webhook:x@db/app" })).toBe(
      "postgres://app_webhook:x@db/app",
    );
  });
});

describe("readDispatchDatabaseUrl", () => {
  it("requires a valid URL", () => {
    expect(() => readDispatchDatabaseUrl({})).toThrow("DISPATCH_DATABASE_URL is required");
    expect(readDispatchDatabaseUrl({ DISPATCH_DATABASE_URL: "postgres://app_dispatch:x@db/app" })).toBe(
      "postgres://app_dispatch:x@db/app",
    );
  });
});

describe("readNfseConfig", () => {
  const nfse = {
    NFSE_MUNICIPAL_SERVICE_ID: "svc_1",
    NFSE_MUNICIPAL_SERVICE_NAME: "Licenciamento de programas",
    NFSE_SERVICE_DESCRIPTION: "Recarga de créditos",
    NFSE_ISS_RATE: "2.5",
  };

  it("returns null when no municipal service is configured (NFS-e off)", () => {
    expect(readNfseConfig({})).toBeNull();
    expect(readNfseConfig({ NFSE_MUNICIPAL_SERVICE_ID: "  ", NFSE_MUNICIPAL_SERVICE_CODE: "" })).toBeNull();
  });

  it("returns the settings, with the ISS retention off by default", () => {
    expect(readNfseConfig(nfse)).toEqual({
      municipalServiceId: "svc_1",
      municipalServiceName: "Licenciamento de programas",
      serviceDescription: "Recarga de créditos",
      issRate: 2.5,
      retainIss: false,
    });
  });

  it("accepts a municipal service code instead of an id and the retention flag", () => {
    const { NFSE_MUNICIPAL_SERVICE_ID: _id, ...rest } = nfse;
    expect(readNfseConfig({ ...rest, NFSE_MUNICIPAL_SERVICE_CODE: "1.05", NFSE_RETAIN_ISS: "true" })).toMatchObject({
      municipalServiceCode: "1.05",
      retainIss: true,
    });
  });

  it.each([
    [{ NFSE_MUNICIPAL_SERVICE_NAME: "" }, "NFSE_MUNICIPAL_SERVICE_NAME is required"],
    [{ NFSE_SERVICE_DESCRIPTION: "" }, "NFSE_SERVICE_DESCRIPTION is required"],
    [{ NFSE_ISS_RATE: "" }, "NFSE_ISS_RATE is required"],
    [{ NFSE_ISS_RATE: "abc" }, "NFSE_ISS_RATE must be a number between 0 and 5"],
    [{ NFSE_ISS_RATE: "7" }, "NFSE_ISS_RATE must be a number between 0 and 5"],
    [{ NFSE_RETAIN_ISS: "yes" }, "NFSE_RETAIN_ISS must be true or false"],
  ])("rejects an incomplete or invalid setup %j", (override, message) => {
    expect(() => readNfseConfig({ ...nfse, ...override })).toThrow(message);
  });
});

describe("readWhatsappConfig", () => {
  const shared = {
    WHATSAPP_PHONE_NUMBER_ID: "123456789012345",
    WHATSAPP_APP_SECRET: "a".repeat(32),
    WHATSAPP_VERIFY_TOKEN: "v".repeat(32),
  };
  const meta = { ...shared, WHATSAPP_DRIVER: "meta", WHATSAPP_ACCESS_TOKEN: "token-123" };

  it("returns null when the driver is empty or missing", () => {
    expect(readWhatsappConfig({})).toBeNull();
    expect(readWhatsappConfig({ WHATSAPP_DRIVER: "  " })).toBeNull();
  });

  it("reads the fake driver with the webhook values and no access token", () => {
    expect(readWhatsappConfig({ ...shared, WHATSAPP_DRIVER: "fake" })).toEqual({
      driver: "fake",
      phoneNumberId: "123456789012345",
      appSecret: "a".repeat(32),
      verifyToken: "v".repeat(32),
    });
  });

  it("turns WhatsApp off for the fake driver in production", () => {
    expect(readWhatsappConfig({ ...shared, WHATSAPP_DRIVER: "fake", NODE_ENV: "production" })).toBeNull();
  });

  it("turns WhatsApp off for an empty driver or phone number id in production", () => {
    expect(readWhatsappConfig({ ...shared, WHATSAPP_DRIVER: "", NODE_ENV: "production" })).toBeNull();
    expect(readWhatsappConfig({ ...meta, WHATSAPP_PHONE_NUMBER_ID: " ", NODE_ENV: "production" })).toBeNull();
  });

  it("still refuses an empty phone number id outside production", () => {
    expect(() => readWhatsappConfig({ ...meta, WHATSAPP_PHONE_NUMBER_ID: "" })).toThrow(
      "WHATSAPP_PHONE_NUMBER_ID is required",
    );
  });

  it("reads the meta driver with the default Graph URL and the version", () => {
    expect(readWhatsappConfig({ ...meta, WHATSAPP_GRAPH_VERSION: "v21.0" })).toEqual({
      driver: "meta",
      accessToken: "token-123",
      phoneNumberId: "123456789012345",
      appSecret: "a".repeat(32),
      verifyToken: "v".repeat(32),
      graphBaseUrl: "https://graph.facebook.com",
      graphVersion: "v21.0",
    });
  });

  it("accepts a custom https Graph URL", () => {
    expect(
      readWhatsappConfig({ ...meta, WHATSAPP_GRAPH_VERSION: "v21.0", WHATSAPP_GRAPH_BASE_URL: "https://graph.example.test" }),
    ).toMatchObject({ graphBaseUrl: "https://graph.example.test" });
  });

  it.each([
    [{ WHATSAPP_DRIVER: "other" }, "WHATSAPP_DRIVER must be meta or fake"],
    [{ WHATSAPP_ACCESS_TOKEN: "" }, "WHATSAPP_ACCESS_TOKEN is required"],
    [{ WHATSAPP_PHONE_NUMBER_ID: "" }, "WHATSAPP_PHONE_NUMBER_ID is required"],
    [{ WHATSAPP_PHONE_NUMBER_ID: "12ab" }, "WHATSAPP_PHONE_NUMBER_ID must contain only digits"],
    [{ WHATSAPP_APP_SECRET: "short" }, "WHATSAPP_APP_SECRET must be at least 32 characters"],
    [{ WHATSAPP_VERIFY_TOKEN: "short" }, "WHATSAPP_VERIFY_TOKEN must be at least 32 characters"],
    [{ WHATSAPP_GRAPH_VERSION: "" }, "WHATSAPP_GRAPH_VERSION is required"],
    [{ WHATSAPP_GRAPH_VERSION: "21.0" }, "WHATSAPP_GRAPH_VERSION must look like v21.0"],
    [{ WHATSAPP_GRAPH_BASE_URL: "http://graph.example.test" }, "WHATSAPP_GRAPH_BASE_URL must use https"],
    [{ WHATSAPP_GRAPH_BASE_URL: "not a url" }, "WHATSAPP_GRAPH_BASE_URL must be a valid URL"],
  ])("rejects an invalid meta setup %j", (override, message) => {
    expect(() => readWhatsappConfig({ ...meta, WHATSAPP_GRAPH_VERSION: "v21.0", ...override })).toThrow(message);
  });
});

describe("readNotificationsDispatchSecret", () => {
  const secret = "d".repeat(32);

  it("returns the secret", () => {
    expect(readNotificationsDispatchSecret({ NOTIFICATIONS_DISPATCH_SECRET: ` ${secret} ` })).toBe(secret);
  });

  it("requires the secret", () => {
    expect(() => readNotificationsDispatchSecret({})).toThrow("NOTIFICATIONS_DISPATCH_SECRET is required");
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(() => readNotificationsDispatchSecret({ NOTIFICATIONS_DISPATCH_SECRET: "short" })).toThrow(
      "NOTIFICATIONS_DISPATCH_SECRET must be at least 32 characters",
    );
  });

  it("accepts the example value outside production and rejects it in production", () => {
    const env = { NOTIFICATIONS_DISPATCH_SECRET: NOTIFICATIONS_DISPATCH_SECRET_EXAMPLE };
    expect(NOTIFICATIONS_DISPATCH_SECRET_EXAMPLE).toBe("local-dispatch-secret-0123456789abcdef");
    expect(readNotificationsDispatchSecret(env)).toBe(NOTIFICATIONS_DISPATCH_SECRET_EXAMPLE);
    expect(() => readNotificationsDispatchSecret({ ...env, NODE_ENV: "production" })).toThrow(
      "NOTIFICATIONS_DISPATCH_SECRET must not be the .env.example placeholder",
    );
  });
});
