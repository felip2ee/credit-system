import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { CHANNEL_LABEL, NOTIFICATION_BADGE } from "@/components/notifications/notification-logic";
import { NotificationLogTable } from "@/components/notifications/NotificationLogTable";
import { TemplateList } from "@/components/notifications/TemplateList";
import { TestNotificationForm } from "@/components/notifications/TestNotificationForm";
import { Button } from "@/components/ui/button";
import { getRequiredSession } from "@/lib/auth/session";
import { listBureauNames } from "@/lib/bureaus/queries";
import { hasPermission } from "@/lib/db/permissions";
import { isValidNotificationCursor, listNotifications, listTemplates } from "@/lib/notifications/queries";
import type { NotificationChannel, NotificationStatus } from "@/lib/notifications/types";

export const metadata = { title: "Notificações" };

const PAGE_SIZE = 50;

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

export default async function SuperadminNotificationsPage({
  searchParams,
}: {
  searchParams: { status?: string; channel?: string; cursor?: string };
}) {
  const session = await getRequiredSession();
  if (!hasPermission(session, "notifications:manage")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Notificações" />
        <p className="text-sm text-muted-foreground">Você não tem permissão para ver as notificações.</p>
      </div>
    );
  }
  const inSupport = Boolean(session.supportSessionId || session.support);
  const canWrite = session.role === "superadmin" && !inSupport;

  const status = pick(searchParams.status, Object.keys(NOTIFICATION_BADGE) as NotificationStatus[]);
  const channel = pick<NotificationChannel>(searchParams.channel, ["email", "whatsapp"]);
  const cursor = searchParams.cursor && isValidNotificationCursor(searchParams.cursor) ? searchParams.cursor : null;

  const [page, templates, names] = await Promise.all([
    listNotifications(session, { status, channel, limit: PAGE_SIZE, cursor }),
    canWrite ? listTemplates(session) : Promise.resolve([]),
    listBureauNames(session),
  ]);

  const filterParams = new URLSearchParams();
  if (status) filterParams.set("status", status);
  if (channel) filterParams.set("channel", channel);
  const nextParams = new URLSearchParams(filterParams.toString());
  if (page.nextCursor) nextParams.set("cursor", page.nextCursor);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Notificações"
        description="Log de envios por e-mail e WhatsApp. Destinatários aparecem mascarados."
      />

      {canWrite ? (
        <section className="space-y-3" aria-labelledby="test-heading">
          <h2 id="test-heading" className="text-lg font-medium">
            Enviar teste
          </h2>
          <TestNotificationForm />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Encerre a sessão de suporte para enviar testes, repetir envios e ver os templates.
        </p>
      )}

      <section className="space-y-3" aria-labelledby="log-heading">
        <h2 id="log-heading" className="text-lg font-medium">
          Log
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filtrar log">
          <div className="space-y-1">
            <label htmlFor="f-status" className="text-sm font-medium">
              Estado
            </label>
            <select
              id="f-status"
              name="status"
              defaultValue={status ?? ""}
              className="flex h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Todos</option>
              {(Object.keys(NOTIFICATION_BADGE) as NotificationStatus[]).map((s) => (
                <option key={s} value={s}>
                  {s} ({NOTIFICATION_BADGE[s].label})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="f-channel" className="text-sm font-medium">
              Canal
            </label>
            <select
              id="f-channel"
              name="channel"
              defaultValue={channel ?? ""}
              className="flex h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Todos</option>
              {(Object.keys(CHANNEL_LABEL) as NotificationChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
        </form>
        <NotificationLogTable
          key={page.rows[0]?.id ?? "empty"}
          rows={page.rows}
          bureauNames={names}
          canWrite={canWrite}
        />
        <div className="flex gap-3">
          {cursor && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/superadmin/notifications?${filterParams}`}>
                Primeira página
              </Link>
            </Button>
          )}
          {page.nextCursor && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/superadmin/notifications?${nextParams}`}>Próxima página</Link>
            </Button>
          )}
        </div>
      </section>

      {canWrite && (
        <section className="space-y-3" aria-labelledby="tpl-heading">
          <h2 id="tpl-heading" className="text-lg font-medium">
            Templates ativos
          </h2>
          <TemplateList templates={templates.filter((t) => t.status === "active")} />
        </section>
      )}
    </div>
  );
}
