import { NextResponse } from "next/server";
import { safeRedirectPath } from "@/lib/auth/callback";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const next = searchParams.get("next") ?? "/";
  return NextResponse.redirect(safeRedirectPath(next, origin));
}
