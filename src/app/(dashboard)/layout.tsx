import { redirect } from "next/navigation";

import { IdleTimeout } from "@/components/providers/idle-timeout";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen">
      <IdleTimeout />
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar email={user.email ?? null} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
