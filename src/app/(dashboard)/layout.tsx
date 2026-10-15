import { redirect } from "next/navigation";

import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Sidebar } from "@/components/layout/sidebar";
import { SupportBanner } from "@/components/layout/support-banner";
import { Topbar } from "@/components/layout/topbar";
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

  const email = await getTopbarEmail(session);
  const supportBureau = session.support
    ? await getBureau(session, session.support.bureauId)
    : null;

  return (
    <div className="flex min-h-screen">
      <IdleTimeout />
      <Sidebar permissions={permissionsFor(session)} />
      <div className="flex flex-1 flex-col">
        {session.support && (
          <SupportBanner
            bureauName={supportBureau?.name ?? "Bureau"}
            expiresAt={session.support.expiresAt.toISOString()}
          />
        )}
        <Topbar email={email} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
