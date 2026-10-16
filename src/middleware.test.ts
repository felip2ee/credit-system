import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "@/middleware";

function run(path: string) {
  return middleware(new NextRequest(`http://localhost:3000${path}`));
}

describe("middleware public paths", () => {
  it.each([
    "/b/reino",
    "/autorizacao-scr/abc123",
    "/api/webhooks/asaas",
    "/api/webhooks/whatsapp",
    "/api/internal/notifications/dispatch",
    "/api/internal/orders/tick",
    "/api/health/live",
    "/api/health/ready",
    "/termos",
    "/privacidade",
    "/cadastro/confirmar-email",
    "/b/reino/cadastro",
  ])("lets %s through without cookie", (path) => {
    const res = run(path);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["/holders", "/bx", "/autorizacao-scrx", "/api/internal/outra", "/api/healthx", "/termosx", "/cadastrox", "/cadastro"])("redirects %s to /login without cookie", (path) => {
    const res = run(path);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
  });
});
