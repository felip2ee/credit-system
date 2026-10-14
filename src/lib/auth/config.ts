import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";

import { config } from "@/lib/config";
import { pool } from "@/lib/db/pool";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/validators/password";

import { clearMustChangePassword } from "./credentials";
import { sendPasswordResetEmail } from "./email";

const isProduction = process.env.NODE_ENV === "production";

function changedPasswordUserId(returned: unknown): string | null {
  if (!returned || typeof returned !== "object" || returned instanceof APIError) return null;
  const user = (returned as { user?: { id?: unknown } }).user;
  return typeof user?.id === "string" ? user.id : null;
}

export const authConfig = {
  appName: "Rainha do Crédito",
  baseURL: config.betterAuthUrl,
  secret: config.betterAuthSecret,
  database: pool,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
    resetPasswordTokenExpiresIn: 15 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: sendPasswordResetEmail,
    onPasswordReset: async ({ user }) => clearMustChangePassword(user.id),
  },
  hooks: {
    // A troca autenticada vale como troca da senha temporária: limpa a flag.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password") return;
      const userId = changedPasswordUserId(ctx.context.returned);
      if (userId) await clearMustChangePassword(userId);
    }),
  },
  user: {
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    expiresIn: 24 * 60 * 60,
    disableSessionRefresh: true,
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      userId: "user_id",
    },
  },
  account: {
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    modelName: "rate_limit",
    fields: { lastRequest: "last_request" },
  },
  trustedOrigins: [config.betterAuthUrl],
  advanced: {
    cookiePrefix: isProduction ? "__Host-credit-system" : "credit-system",
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
    },
    trustedProxyHeaders: isProduction,
    ipAddress: isProduction
      ? { trustedProxies: [config.traefikProxyCidr!] }
      : undefined,
    database: { generateId: "uuid" },
  },
  plugins: [
    twoFactor({
      issuer: "Rainha do Crédito",
      twoFactorTable: "two_factor",
      schema: {
        user: {
          fields: { twoFactorEnabled: "two_factor_enabled" },
        },
        twoFactor: {
          fields: {
            backupCodes: "backup_codes",
            userId: "user_id",
            failedVerificationCount: "failed_verification_count",
            lockedUntil: "locked_until",
          },
        },
      },
    }),
    nextCookies(),
  ],
} satisfies BetterAuthOptions;
