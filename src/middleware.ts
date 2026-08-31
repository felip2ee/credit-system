import { NextResponse, type NextRequest } from "next/server";

const publicPaths = [
  "/login",
  "/reset-password",
  "/update-password",
  "/mfa",
  "/mfa/setup",
  "/mfa/verify",
];

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(({ name }) => name.endsWith(".session_token"));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/auth") || publicPaths.includes(pathname)) {
    return NextResponse.next();
  }
  if (!hasSessionCookie(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
