import { redirect } from "next/navigation";

import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { getRequiredSession } from "@/lib/auth/session";
import { getTopbarEmail } from "@/lib/dashboard/queries";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));

  // Clientes não acessam o painel interno — vão para o portal externo.
  if (session.role === "client") {
    redirect("/portal");
  }

  const email = await getTopbarEmail(session);

  return (
    <div className="flex min-h-screen">
      <IdleTimeout />
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar email={email} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
