import { redirect } from "next/navigation";

import { SuperadminNav } from "@/components/superadmin/superadmin-nav";
import { SUPERADMIN_NAV_ITEMS } from "@/components/layout/nav-items";
import { SupportBanner } from "@/components/layout/support-banner";
import { Toaster } from "@/components/ui/toaster";
import { Topbar } from "@/components/layout/topbar";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";

export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));

  if (session.role !== "superadmin") redirect("/");

  const supportBureau = session.support ? await getBureau(session, session.support.bureauId) : null;

  return (
    <div className="theme-admin flex min-h-screen bg-background">
      {/* Campo focado não fica sob o cabeçalho fixo do celular. */}
      <style>{"@media (max-width:767px){html{scroll-padding-top:4.5rem}}"}</style>
      <SuperadminNav />
      <div className="flex min-w-0 flex-1 flex-col">
        {session.support && (
          <SupportBanner bureauName={supportBureau?.name ?? "Bureau"} expiresAt={session.support.expiresAt.toISOString()} />
        )}
        {/* Fixo no topo no celular (z-40). Os ScreenHeader das telas (sticky, z-30) descem 3.5rem para ficar logo abaixo. */}
        <div className="sticky top-0 z-40 md:static">
          <Topbar email={session.email} navItems={SUPERADMIN_NAV_ITEMS} />
        </div>
        {/* Posiciona os ScreenHeader sticky das telas logo abaixo da barra superior do celular. */}
        <main className="flex-1 p-4 max-md:[&_header.sticky]:top-14 md:p-6">{children}</main>
        <Toaster />
      </div>
    </div>
  );
}
