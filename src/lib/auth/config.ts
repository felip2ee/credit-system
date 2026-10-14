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
    after: createAuthMiddleware(async (ctx) => {
      // A troca autenticada vale como troca da senha temporária: limpa a flag. A senha já mudou
      // e as outras sessões já caíram; lançar aqui daria 500 e perderia o cookie da nova sessão.
      // Se a flag ficar ligada, o layout manda o usuário de volta a /change-password.
      if (ctx.path === "/change-password") {
        const userId = changedPasswordUserId(ctx.context.returned);
        if (!userId) return;
        try {
          await clearMustChangePassword(userId);
        } catch (error) {
          console.error("[auth] falha ao limpar must_change_password", {
            userId,
            error: error instanceof Error ? error.message : "desconhecido",
          });
        }
        return;
      }
      // Cadastro do MFA: o Better Auth troca a sessão atual por uma nova. Qualquer outra sessão
      // aberta antes do TOTP passaria a valer como "MFA completo" (twoFactorEnabled é do usuário,
      // não da sessão), então cai aqui. O login com TOTP não tem sessão prévia e não passa por aqui.
      if (ctx.path === "/two-factor/verify-totp" && ctx.context.session && ctx.context.newSession) {
        const { session, user } = ctx.context.newSession;
        await pool.query('delete from "session" where user_id = $1 and id <> $2', [user.id, session.id]);
      }
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
