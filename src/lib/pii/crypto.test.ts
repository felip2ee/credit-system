import { afterEach, describe, expect, it, vi } from "vitest";

// "@/lib/config" lê o ambiente ao carregar.
vi.hoisted(() => {
  Object.assign(process.env, {
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
  });
});

import { readPiiKeyring } from "@/lib/config";

import { decryptPayerPii, encryptPayerPii, PiiDecryptError } from "./crypto";

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");
const ring1 = readPiiKeyring({ PII_ENCRYPTION_KEY: `k1:${K1}` });
const pii = { document: "52998224725", postalCode: "01310100", addressNumber: "123" };
const AAD = "payer:bureau-1:client-1";

afterEach(() => vi.restoreAllMocks());

describe("encryptPayerPii / decryptPayerPii", () => {
  it("round trips and reports the key id", () => {
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, pii);
    expect(keyId).toBe("k1");
    expect(ciphertext[0]).toBe(1);
    expect(decryptPayerPii(ring1, AAD, ciphertext, keyId)).toEqual(pii);
  });

  it("round trips a partial payload", () => {
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, { postalCode: "01310100" });
    expect(decryptPayerPii(ring1, AAD, ciphertext, keyId)).toEqual({ postalCode: "01310100" });
  });

  it("does not keep the plain text in the blob", () => {
    const { ciphertext } = encryptPayerPii(ring1, AAD, pii);
    expect(ciphertext.toString("utf8")).not.toContain("52998224725");
    expect(ciphertext.toString("latin1")).not.toContain("52998224725");
  });

  it("uses a new IV on every call", () => {
    const a = encryptPayerPii(ring1, AAD, pii).ciphertext;
    const b = encryptPayerPii(ring1, AAD, pii).ciphertext;
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("fails with a different AAD (blob copied to another row)", () => {
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, pii);
    expect(() => decryptPayerPii(ring1, "payer:bureau-1:client-2", ciphertext, keyId)).toThrow(PiiDecryptError);
  });

  it("fails when the tag, the IV or the text is tampered", () => {
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, pii);
    for (const index of [1, 13, ciphertext.length - 1]) {
      const copy = Buffer.from(ciphertext);
      copy[index] ^= 0xff;
      expect(() => decryptPayerPii(ring1, AAD, copy, keyId)).toThrow(PiiDecryptError);
    }
  });

  it("fails on a short blob or an unknown version", () => {
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, pii);
    expect(() => decryptPayerPii(ring1, AAD, ciphertext.subarray(0, 20), keyId)).toThrow(PiiDecryptError);
    const copy = Buffer.from(ciphertext);
    copy[0] = 9;
    expect(() => decryptPayerPii(ring1, AAD, copy, keyId)).toThrow(PiiDecryptError);
  });

  it("decrypts with an old key still in the ring, and encrypts with the first", () => {
    const old = encryptPayerPii(ring1, AAD, pii);
    const rotated = readPiiKeyring({ PII_ENCRYPTION_KEY: `k2:${K2},k1:${K1}` });
    expect(decryptPayerPii(rotated, AAD, old.ciphertext, old.keyId)).toEqual(pii);
    const fresh = encryptPayerPii(rotated, AAD, pii);
    expect(fresh.keyId).toBe("k2");
    expect(() => decryptPayerPii(ring1, AAD, fresh.ciphertext, fresh.keyId)).toThrow(PiiDecryptError);
  });

  it("fails with the wrong key under the same id", () => {
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, pii);
    const other = readPiiKeyring({ PII_ENCRYPTION_KEY: `k1:${K2}` });
    expect(() => decryptPayerPii(other, AAD, ciphertext, keyId)).toThrow(PiiDecryptError);
  });

  it("leaks neither key nor text in the error or in console", () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { ciphertext, keyId } = encryptPayerPii(ring1, AAD, pii);
    let message = "";
    try {
      decryptPayerPii(ring1, "other-aad", ciphertext, keyId);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    for (const secret of [K1, "52998224725", "01310100", AAD, "other-aad"]) expect(message).not.toContain(secret);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
});
