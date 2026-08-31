import { betterAuth } from "better-auth";

import { authConfig } from "./config";

export const auth = betterAuth(authConfig);

const twoFactorTrustPaths = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
]);

function authPath(request: Request): string {
  return new URL(request.url).pathname.replace(/^.*\/api\/auth/, "");
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.clone().json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requestWithBody(request: Request, body: Record<string, unknown>): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
  });
}

export async function authHandler(request: Request): Promise<Response> {
  const path = authPath(request);
  const body = request.method === "POST" ? await jsonBody(request) : null;

  if (twoFactorTrustPaths.has(path) && body?.trustDevice === true) {
    return Response.json({ code: "TRUST_DEVICE_DISABLED" }, { status: 400 });
  }

  if (path === "/change-password" && body) {
    return auth.handler(
      requestWithBody(request, { ...body, revokeOtherSessions: true }),
    );
  }

  return auth.handler(request);
}
