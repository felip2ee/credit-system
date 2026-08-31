import { redirect } from "next/navigation";

import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";

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

  const { rows } = await withUserTransaction(session, (client) =>
    client.query<{ email: string }>(
      "select email from profiles where id = $1",
      [session.userId],
    ),
  );
  const email = rows[0]?.email ?? null;

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
