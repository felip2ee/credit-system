import { redirect } from "next/navigation";

import { SuperadminNav } from "@/components/superadmin/superadmin-nav";
import { Topbar } from "@/components/layout/topbar";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";

export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => {
    if (err instanceof SessionAccessError && err.code === "mfa_setup_required") {
      redirect("/mfa/setup");
    }
    redirect("/login");
  });

  if (session.role !== "superadmin") redirect("/");

  return (
    <div className="flex min-h-screen">
      <SuperadminNav />
      <div className="flex flex-1 flex-col">
        <Topbar email={session.email} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
