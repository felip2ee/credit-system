import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/account/change-password-form";
import { NotificationChannelForm } from "@/components/account/notification-channel-form";
import { PhoneVerificationForm } from "@/components/account/phone-verification-form";
import { RevokeSessionsButton } from "@/components/account/revoke-sessions-button";
import { PageHeader } from "@/components/layout/page-header";
import { AccountMenu } from "@/components/portal/account-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";

export const metadata = { title: "Conta" };

export default async function ClientProfilePage() {
  const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
  if (!hasPermission(session, "portal:read")) redirect("/portal");

  const status = await withUserTransaction(session, (client) => getClientAccountStatus(client, session.userId));

  return (
    <div className="space-y-6">
      <PageHeader title="Conta" description="Seus dados, telefone, avisos e segurança" />
      <AccountMenu showAffiliates={hasPermission(session, "affiliates:read")} />
      <Card>
        <CardHeader>
          <CardTitle>Dados da conta</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Nome</dt>
            <dd>{session.name}</dd>
            <dt className="text-muted-foreground">E-mail</dt>
            <dd className="break-all">{session.email}</dd>
            <dt className="text-muted-foreground">Documento</dt>
            <dd>{status.documentMasked ?? "Não informado"}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Telefone</CardTitle>
        </CardHeader>
        <CardContent>
          <PhoneVerificationForm phoneE164={status.phoneE164} phoneVerified={status.phoneVerified} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Notificações</CardTitle>
        </CardHeader>
        <CardContent>
          <NotificationChannelForm channel={status.notificationChannel} phoneVerified={status.phoneVerified} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Segurança</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <ChangePasswordForm />
          <RevokeSessionsButton />
        </CardContent>
      </Card>
    </div>
  );
}
