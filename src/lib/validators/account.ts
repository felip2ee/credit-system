import { z } from "zod";

export const phoneRequestSchema = z.object({
  phone: z.string().trim().min(10, "Informe o celular com DDD.").max(30, "Celular inválido."),
});
export const phoneCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Informe o código de 6 dígitos."),
});
export const notificationChannelSchema = z.object({ channel: z.enum(["email", "whatsapp"]) });
export const legalAcceptSchema = z.object({
  termsVersion: z.number().int().positive(),
  privacyVersion: z.number().int().positive(),
});
export const EMAIL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const emailTokenSchema = z.string().regex(EMAIL_TOKEN_PATTERN);
