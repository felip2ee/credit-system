import { createHash, randomBytes } from "node:crypto";

// 32 bytes em base64url = 43 caracteres. O formato é conferido antes de qualquer consulta ao banco.
export const PAYMENT_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// Só o hash vai ao banco: o token em claro existe apenas na criação do link.
export function generateToken(): { token: string; hash: string } {
	const token = randomBytes(32).toString("base64url");
	return { token, hash: hashToken(token) };
}
