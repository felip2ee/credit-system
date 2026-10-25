import { redirect } from "next/navigation";

import { SuperadminNav } from "@/components/superadmin/superadmin-nav";
import { SUPERADMIN_NAV_ITEMS } from "@/components/layout/nav-items";
import { Toaster } from "@/components/ui/toaster";
import { Topbar } from "@/components/layout/topbar";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";

export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));

  if (session.role !== "superadmin") redirect("/");

  return (
    <div className="flex min-h-screen bg-surface">
      <SuperadminNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar email={session.email} navItems={SUPERADMIN_NAV_ITEMS} />
        <main className="flex-1 p-4 md:p-6">{children}</main>
        <Toaster />
      </div>
    </div>
  );
}
