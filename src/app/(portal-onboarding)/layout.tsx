import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { IdleTimeout } from "@/components/providers/idle-timeout";
import { BrandLogo } from "@/components/portal/brand-logo";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";

export default async function PortalOnboardingLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (session.role !== "client") redirect("/");
  const status = await withUserTransaction(session, (client) => getClientAccountStatus(client, session.userId));
  if (status.termsAccepted) redirect("/portal");

  return (
    <div className="area-portal flex min-h-screen flex-col bg-surface">
      <IdleTimeout />
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-screen py-3">
          <BrandLogo variant="full" />
          <form action={signOut}>
            <Button type="submit" variant="outline">
              <LogOut aria-hidden />
              Sair
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-screen py-6">{children}</main>
      <Toaster />
    </div>
  );
}
