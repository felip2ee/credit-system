import { NextResponse, type NextRequest } from "next/server";

const publicPaths = [
  "/login",
  "/reset-password",
  "/update-password",
  "/mfa",
  "/mfa/setup",
  "/mfa/verify",
  "/termos",
  "/privacidade",
  "/api/webhooks/asaas",
  "/api/webhooks/whatsapp",
  "/api/internal/notifications/dispatch",
  "/api/internal/orders/tick",
  "/api/health/live",
  "/api/health/ready",
  "/manifest.webmanifest",
  "/sw.js",
];

const publicPrefixes = ["/b/", "/autorizacao-scr/", "/cadastro/"];

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(({ name }) => name.endsWith(".session_token"));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/api/auth") ||
    publicPaths.includes(pathname) ||
    publicPrefixes.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }
  // Server Action sem sessão: não redireciona (o 307 vira POST em /login e o cliente recebe undefined).
  // Toda action confere a própria sessão e devolve { error }.
  const isServerAction = request.method === "POST" && request.headers.has("next-action");
  if (!hasSessionCookie(request) && !isServerAction) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
