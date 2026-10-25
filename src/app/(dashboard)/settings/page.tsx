import { ScrollText, ShieldCheck, Users } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
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

      <Card className="divide-y divide-border overflow-hidden">
        <ListRow
          href="/settings/security"
          icon={ShieldCheck}
          title="Segurança (MFA)"
          subtitle="Cadastre um autenticador TOTP para sua conta."
        />
        {admin && (
          <ListRow
            href="/settings/users"
            icon={Users}
            title="Equipe"
            subtitle="Convide e gerencie operadores e administradores."
          />
        )}
        {admin && (
          <ListRow
            href="/settings/audit"
            icon={ScrollText}
            title="Auditoria"
            subtitle="Trilha de acessos ao bureau (quem consultou o quê e quando)."
          />
        )}
      </Card>
    </div>
  );
}
