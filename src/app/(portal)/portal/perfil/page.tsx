import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/account/change-password-form";
import { NotificationChannelForm } from "@/components/account/notification-channel-form";
import { PhoneVerificationForm } from "@/components/account/phone-verification-form";
import { RevokeSessionsButton } from "@/components/account/revoke-sessions-button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";

export const metadata = { title: "Perfil" };

export default async function ClientProfilePage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "portal:read")) redirect("/portal");

  const status = await withUserTransaction(session, (client) => getClientAccountStatus(client, session.userId));

  return (
    <div className="space-y-6">
      <PageHeader title="Perfil" description="Dados da conta, telefone, notificações e segurança" />
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Dados da conta</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Nome</dt>
            <dd>{session.name}</dd>
            <dt className="text-muted-foreground">E-mail</dt>
            <dd>{session.email}</dd>
            <dt className="text-muted-foreground">Documento</dt>
            <dd>{status.documentMasked ?? "Não informado"}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Telefone</CardTitle>
        </CardHeader>
        <CardContent>
          <PhoneVerificationForm phoneE164={status.phoneE164} phoneVerified={status.phoneVerified} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notificações</CardTitle>
        </CardHeader>
        <CardContent>
          <NotificationChannelForm channel={status.notificationChannel} phoneVerified={status.phoneVerified} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Segurança</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <ChangePasswordForm />
          <RevokeSessionsButton />
        </CardContent>
      </Card>
    </div>
  );
}
