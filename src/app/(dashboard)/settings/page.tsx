import Link from "next/link";
import { ScrollText, ShieldCheck, Users } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { redirect } from "next/navigation";

import { getRequiredSession } from "@/lib/auth/session";

export default async function SettingsPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  const admin = session.role === "bureau_admin";

  return (
    <div>
      <PageHeader
        title="Configurações"
        description="Gestão da conta e da operação"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/settings/security">
          <Card className="h-full transition-colors hover:bg-muted/50">
            <CardHeader>
              <ShieldCheck className="mb-2 h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Segurança (MFA)</CardTitle>
              <CardDescription>
                Cadastre um autenticador TOTP para sua conta.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>

        {admin && (
          <Link href="/settings/users">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <Users className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Equipe</CardTitle>
                <CardDescription>
                  Convide e gerencie operadores e administradores.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}

        {admin && (
          <Link href="/settings/audit">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <ScrollText className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Auditoria</CardTitle>
                <CardDescription>
                  Trilha de acessos ao bureau (quem consultou o quê e quando).
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}
      </div>
    </div>
  );
}
