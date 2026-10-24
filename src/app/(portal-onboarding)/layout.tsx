import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Button } from "@/components/ui/button";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";

export default async function PortalOnboardingLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (session.role !== "client") redirect("/");
  const status = await withUserTransaction(session, (client) => getClientAccountStatus(client, session.userId));
  if (status.termsAccepted) redirect("/portal");

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <IdleTimeout />
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="text-base font-semibold">Rainha Cred</span>
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              <LogOut className="h-4 w-4" />
              Sair
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
