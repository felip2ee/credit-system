import { redirect } from "next/navigation";

import { signOut } from "@/actions/auth";
import { IdleTimeout } from "@/components/providers/idle-timeout";
import { DASHBOARD_NAV_ITEMS } from "@/components/layout/nav-items";
import { Toaster } from "@/components/ui/toaster";
import { Sidebar } from "@/components/layout/sidebar";
import { SupportBanner } from "@/components/layout/support-banner";
import { MobileBrand } from "@/components/layout/brand-mark";
import { MobileNav } from "@/components/layout/mobile-nav";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { permissionsFor } from "@/lib/db/permissions";
import { getBureau } from "@/lib/bureaus/queries";
import { getTopbarEmail } from "@/lib/dashboard/queries";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));

  // Clientes não acessam o painel interno — vão para o portal externo.
  if (session.role === "client") {
    redirect("/portal");
  }

  // Superadmin só entra no painel do Bureau em modo suporte.
  if (session.role === "superadmin" && !session.supportSessionId) {
    redirect("/superadmin");
  }

  const permissions = permissionsFor(session);
  const email = await getTopbarEmail(session);
  const supportBureau = session.support
    ? await getBureau(session, session.support.bureauId)
    : null;

  return (
    <div className="theme-admin flex min-h-screen bg-background">
      <IdleTimeout />
      {/* Campo focado não fica sob o cabeçalho fixo do celular. */}
      <style>{"@media (max-width:767px){html{scroll-padding-top:4.5rem}}"}</style>
      <Sidebar permissions={permissions} name={session.name} email={email} />
      <div className="flex min-w-0 flex-1 flex-col">
        {session.support && (
          <SupportBanner
            bureauName={supportBureau?.name ?? "Bureau"}
            expiresAt={session.support.expiresAt.toISOString()}
          />
        )}
        {/* Fixo no topo no celular (h-14, z-40). Os ScreenHeader das telas (sticky, z-30) descem 3.5rem para ficar logo abaixo. */}
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-2 border-b border-sidebar-border bg-sidebar px-4 md:hidden">
          <MobileBrand />
          <MobileNav items={DASHBOARD_NAV_ITEMS} permissions={permissions} signOutAction={signOut} />
        </header>
        {/* Posiciona os ScreenHeader sticky das telas logo abaixo da barra superior do celular. */}
        <main className="flex-1 p-4 max-md:[&_header.sticky]:top-14 md:p-6">{children}</main>
        <Toaster />
      </div>
    </div>
  );
}
