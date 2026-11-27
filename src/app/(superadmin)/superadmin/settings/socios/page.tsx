import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { PartnerForm } from "@/components/superadmin/partner-form";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listPartners } from "@/lib/partners/queries";

export const metadata = { title: "Sócios" };

export default async function PartnersPage() {
	const session = await getRequiredSession().catch(() => redirect("/login"));
	if (!hasPermission(session, "partner:manage") || session.supportSessionId) redirect("/");
	const partners = await listPartners(session);
	const activeTotal = partners.filter((p) => p.active).reduce((sum, p) => sum + Number(p.pct), 0);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Sócios"
				description={`Recebem, por split do Asaas, uma % do valor líquido de toda cobrança. Total ativo: ${activeTotal.toLocaleString("pt-BR")}%. A plataforma fica com o resto.`}
			/>
			{partners.map((p) => (
				<PartnerForm key={p.id} partner={p} />
			))}
			<PartnerForm />
		</div>
	);
}
