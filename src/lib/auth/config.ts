import type { BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";

import { config } from "@/lib/config";
import { pool } from "@/lib/db/pool";

import { sendPasswordResetEmail } from "./email";

const isProduction = process.env.NODE_ENV === "production";

export const authConfig = {
  appName: "Rainha do Crédito",
  baseURL: config.betterAuthUrl,
  secret: config.betterAuthSecret,
  database: pool,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 15 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: sendPasswordResetEmail,
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
    useSecureCookies: false,
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
