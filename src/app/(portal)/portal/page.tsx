import { FolderOpen } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export default async function PortalHomePage() {
  const session = await getRequiredSession();
  if (!hasPermission(session, "portal:read")) return null;
  const profile = await getCurrentProfile();
  const firstName = profile?.full_name.split(" ")[0] ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Olá{firstName ? `, ${firstName}` : ""}</h1>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-lg">Suas pesquisas</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <FolderOpen className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Assim que uma pesquisa for liberada para você, ela aparecerá aqui.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
