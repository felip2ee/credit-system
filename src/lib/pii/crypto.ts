import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { PiiKeyring } from "@/lib/config";

// Blob: versão (1 byte) + IV (12) + tag (16) + texto cifrado do JSON. AES-256-GCM.
// O AAD (payer:<bureau_id>:<client_profile_id ou "bureau">) amarra o blob à linha: copiado para outra, não decifra.
const BLOB_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export type PayerPii = { document?: string; postalCode?: string; addressNumber?: string };

// Mensagem fixa: nunca leva chave, AAD nem texto.
export class PiiDecryptError extends Error {
  constructor() {
    super("PII decryption failed");
    this.name = "PiiDecryptError";
  }
}

export function encryptPayerPii(keyring: PiiKeyring, aad: string, pii: PayerPii): { ciphertext: Buffer; keyId: string } {
  const keyId = keyring.activeKeyId;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error("PII keyring has no active key");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(pii), "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([Buffer.of(BLOB_VERSION), iv, cipher.getAuthTag(), body]), keyId };
}

export function decryptPayerPii(keyring: PiiKeyring, aad: string, ciphertext: Buffer, keyId: string): PayerPii {
  const key = keyring.keys.get(keyId);
  if (!key || ciphertext.length <= HEADER_BYTES || ciphertext[0] !== BLOB_VERSION) throw new PiiDecryptError();

  try {
    const iv = ciphertext.subarray(1, 1 + IV_BYTES);
    const tag = ciphertext.subarray(1 + IV_BYTES, HEADER_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(HEADER_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as PayerPii;
  } catch {
    throw new PiiDecryptError();
  }
}
