import { redirect } from "next/navigation";

import { headerBalance, portalNavItems } from "@/components/portal/nav-items";
import { BottomNav } from "@/components/portal/bottom-nav";
import { PortalHeader } from "@/components/portal/portal-header";
import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Toaster } from "@/components/ui/toaster";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getClientAccountStatus } from "@/lib/account/queries";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getClientWallet } from "@/lib/wallet/client-queries";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (session.role !== "client") redirect("/");
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  const canReadCredits = hasPermission(session, "credits:read");
  const { status, wallet } = await withUserTransaction(session, async (c) => ({
    status: await getClientAccountStatus(c, session.userId),
    wallet: canReadCredits ? await getClientWallet(c, session.userId) : null,
  }));
  if (!status.termsAccepted) redirect("/portal/termos");
  const items = portalNavItems({ credits: canReadCredits, affiliates: hasPermission(session, "affiliates:read") });

  return (
    <div className="area-portal portal-dense flex min-h-screen flex-col bg-background">
      <IdleTimeout />
      <PortalHeader items={items} balance={headerBalance(canReadCredits, wallet)} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-screen py-6 dense:py-4 pb-28 md:max-w-5xl md:pb-6">{children}</main>
      <BottomNav items={items} />
      <Toaster />
    </div>
  );
}
