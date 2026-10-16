import { randomBytes, randomInt } from "node:crypto";

// 32 bytes = 256 bits; base64url sem padding = 43 caracteres (casa com EMAIL_TOKEN_PATTERN e com a 021).
export function generateEmailToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePhoneCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
