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

  // Catches: the superadmin bootstrap password never being read from its Docker secret.
  it("reads SUPERADMIN_PASSWORD from its secret file", () => {
    const env = { SUPERADMIN_PASSWORD_FILE: secretFile("pw-from-file-123") } as unknown as NodeJS.ProcessEnv;

    hydrateSecretEnv(env);

    expect(env.SUPERADMIN_PASSWORD).toBe("pw-from-file-123");
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
