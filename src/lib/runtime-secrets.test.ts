import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hydrateSecretEnv } from "./runtime-secrets.mjs";

const dirs: string[] = [];

function secretFile(value: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docker-secret-"));
  dirs.push(dir);
  const file = path.join(dir, "value");
  writeFileSync(file, `${value}\n`);
  return file;
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("hydrateSecretEnv", () => {
  // Catches: Docker secret files reaching config as file paths instead of secret values.
  it("reads a mounted secret file into its runtime variable", () => {
    const env = {
      DATABASE_URL_FILE: secretFile("postgres://runtime:pw@db/app"),
    } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.DATABASE_URL).toBe("postgres://runtime:pw@db/app");
  });

  // Catches: the webhook route reading a file path instead of the app_webhook DSN.
  it("reads DATABASE_WEBHOOK_URL from its secret file", () => {
    const env = { DATABASE_WEBHOOK_URL_FILE: secretFile("postgres://app_webhook:pw@db/app") } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.DATABASE_WEBHOOK_URL).toBe("postgres://app_webhook:pw@db/app");
  });

  // Catches: the dispatch route reading a file path instead of the app_dispatch DSN.
  it("reads DISPATCH_DATABASE_URL from its secret file", () => {
    const env = { DISPATCH_DATABASE_URL_FILE: secretFile("postgres://app_dispatch:pw@db/app") } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.DISPATCH_DATABASE_URL).toBe("postgres://app_dispatch:pw@db/app");
  });

  // Catches: the superadmin bootstrap password never being read from its Docker secret.
  it("reads SUPERADMIN_PASSWORD from its secret file", () => {
    const env = { SUPERADMIN_PASSWORD_FILE: secretFile("pw-from-file-123") } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.SUPERADMIN_PASSWORD).toBe("pw-from-file-123");
  });

  // Catches: the WhatsApp and dispatch secrets reaching config as file paths.
  it("reads the WhatsApp and dispatch secrets from their secret files", () => {
    const env = {
      WHATSAPP_ACCESS_TOKEN_FILE: secretFile("wa-token"),
      WHATSAPP_APP_SECRET_FILE: secretFile("wa-app-secret"),
      WHATSAPP_VERIFY_TOKEN_FILE: secretFile("wa-verify"),
      NOTIFICATIONS_DISPATCH_SECRET_FILE: secretFile("dispatch-secret"),
    } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.WHATSAPP_ACCESS_TOKEN).toBe("wa-token");
    expect(env.WHATSAPP_APP_SECRET).toBe("wa-app-secret");
    expect(env.WHATSAPP_VERIFY_TOKEN).toBe("wa-verify");
    expect(env.NOTIFICATIONS_DISPATCH_SECRET).toBe("dispatch-secret");
  });

  // Catches: the VAPID private key reaching config as a file path.
  it("reads WEB_PUSH_VAPID_PRIVATE_KEY from its secret file", () => {
    const env = { WEB_PUSH_VAPID_PRIVATE_KEY_FILE: secretFile("vapid-private") } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.WEB_PUSH_VAPID_PRIVATE_KEY).toBe("vapid-private");
  });

  // Catches: the PII key ring reaching config as a file path.
  it("reads PII_ENCRYPTION_KEY from its secret file", () => {
    const env = { PII_ENCRYPTION_KEY_FILE: secretFile("k1:abc") } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.PII_ENCRYPTION_KEY).toBe("k1:abc");
  });

  // Catches: a missing Docker Secret allowing the service to start with an empty credential.
  it("fails closed when a configured secret file is empty", () => {
    expect(() => hydrateSecretEnv({ BETTER_AUTH_SECRET_FILE: secretFile("") } as unknown as NodeJS.ProcessEnv)).toThrow(
      "BETTER_AUTH_SECRET secret file is empty",
    );
  });

  // Catches: changing local env behavior when no Docker secret file is mounted.
  it("keeps direct environment secrets unchanged", () => {
    const env = { SMTP_PASS: "local-password" } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.SMTP_PASS).toBe("local-password");
  });
});
