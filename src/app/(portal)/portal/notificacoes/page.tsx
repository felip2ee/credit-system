import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { InstallGuide } from "@/components/portal/push/install-guide";
import { PushToggle } from "@/components/portal/push/push-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { readPushConfig } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Notificações" };

function publicPushKey(): string | null {
	try {
		return readPushConfig(process.env)?.publicKey ?? null;
	} catch (error) {
		console.warn("[push] configuração inválida", { name: error instanceof Error ? error.name : typeof error });
		return null;
	}
}

export default async function PortalNotificationsPage() {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (!hasPermission(session, "portal:read")) redirect("/portal");

	return (
		<div className="space-y-4">
			<PageHeader title="Notificações" description="Avisos neste aparelho" />
			<Card>
				<CardHeader>
					<CardTitle className="text-xl">Avisos no aparelho</CardTitle>
				</CardHeader>
				<CardContent>
					<PushToggle publicKey={publicPushKey()} />
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-xl">Instalar no aparelho</CardTitle>
				</CardHeader>
				<CardContent>
					<InstallGuide />
				</CardContent>
			</Card>
		</div>
	);
}
