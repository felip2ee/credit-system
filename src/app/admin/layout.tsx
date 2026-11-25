import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { AdminNav } from "@/components/admin/admin-nav";
import { MobileBrand } from "@/components/layout/brand-mark";
import { SupportBanner } from "@/components/layout/support-banner";
import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Toaster } from "@/components/ui/toaster";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";

export const metadata: Metadata = {
  title: "Painel",
  manifest: "/admin/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Rainha Cred Admin", statusBarStyle: "default" },
};

export default async function AdminAppLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));

  // Clientes não acessam o painel interno — vão para o portal externo.
  if (session.role === "client") {
    redirect("/portal");
  }

  // Superadmin só entra no painel do Bureau em modo suporte.
  if (session.role === "superadmin" && !session.supportSessionId) {
    redirect("/superadmin");
  }

  const supportBureau = session.support ? await getBureau(session, session.support.bureauId) : null;

  return (
    <div className="theme-admin flex min-h-screen flex-col bg-background">
      <IdleTimeout />
      {session.support && (
        <SupportBanner bureauName={supportBureau?.name ?? "Bureau"} expiresAt={session.support.expiresAt.toISOString()} />
      )}
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar px-4">
        <MobileBrand />
        <AdminNav variant="top" />
        <form action={signOut}>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-bold text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
          >
            <LogOut aria-hidden className="size-[18px]" />
            Sair
          </button>
        </form>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>
      <AdminNav variant="bottom" />
      <Toaster />
    </div>
  );
}
