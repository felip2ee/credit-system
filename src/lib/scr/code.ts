import { randomInt } from "node:crypto";

// Alfabeto sem 0/O/1/I. O código é a credencial do consentimento (D32): sempre randomInt, nunca Math.random.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateScrCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}
