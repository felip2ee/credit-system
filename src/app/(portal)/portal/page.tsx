import Link from "next/link";
import { FolderOpen } from "lucide-react";

import { ClientOrderList } from "@/components/orders/client-order-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listMyOrders } from "@/lib/orders/client-queries";

const RECENT_ORDERS = 5;

export default async function PortalHomePage() {
  const session = await getRequiredSession();
  if (!hasPermission(session, "portal:read")) return null;
  const profile = await getCurrentProfile();
  const firstName = profile?.full_name.split(" ")[0] ?? "";
  const orders = await withUserTransaction(session, (client) => listMyOrders(client, RECENT_ORDERS));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Olá{firstName ? `, ${firstName}` : ""}</h1>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Suas pesquisas</CardTitle>
          {orders.length > 0 && (
            <Link href="/portal/pesquisas" className="text-sm underline">
              Ver todas
            </Link>
          )}
        </CardHeader>
        <CardContent>
          {orders.length > 0 ? (
            <ClientOrderList orders={orders} />
          ) : (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Assim que uma pesquisa for liberada para você, ela aparecerá aqui.</p>
              <Button asChild>
                <Link href="/portal/pesquisas/nova">Nova pesquisa</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
