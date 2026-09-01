import { redirect } from "next/navigation";
import Link from "next/link";
import { LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Button } from "@/components/ui/button";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequiredSession().catch((err) => {
    if (err instanceof SessionAccessError && err.code === "mfa_setup_required") {
      redirect("/mfa/setup");
    }
    redirect("/login");
  });
  if (session.role !== "client") redirect("/");
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <IdleTimeout />
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/portal" className="flex flex-col leading-tight">
            <span className="text-base font-semibold">Rainha do Crédito</span>
            <span className="text-xs text-muted-foreground">Portal do Cliente</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{profile.full_name}</span>
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                <LogOut className="h-4 w-4" />
                Sair
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
