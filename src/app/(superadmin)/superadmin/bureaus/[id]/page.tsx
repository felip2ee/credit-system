import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHeader } from "@/components/layout/page-header";
import { BureauEditForm } from "@/components/superadmin/bureau-edit-form";
import { AdminCredentialsForm } from "@/components/superadmin/admin-credentials-form";
import { InviteAdminForm } from "@/components/superadmin/invite-admin-form";
import { SupportStartForm } from "@/components/superadmin/support-start-form";
import { BureauCostsPanel } from "@/components/superadmin/bureau-costs-panel";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";
import { listBureauCosts } from "@/lib/catalog/queries";
import { hasPermission } from "@/lib/db/permissions";

export const metadata = { title: "Bureau" };

export default async function BureauDetailPage({ params }: { params: { id: string } }) {
  if (!z.string().uuid().safeParse(params.id).success) notFound();
  const session = await getRequiredSession();
  const bureau = await getBureau(session, params.id);
  if (!bureau) notFound();
  const costs = hasPermission(session, "catalog:read") ? await listBureauCosts(session, bureau.id) : null;

  return (
    <div className="space-y-6">
      <PageHeader title={bureau.name} description={`Endereço público: /b/${bureau.slug}`} />
      <BureauEditForm bureau={bureau} />
      <InviteAdminForm bureauId={bureau.id} />
      <AdminCredentialsForm bureauId={bureau.id} />
      <SupportStartForm bureauId={bureau.id} />
      {costs && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Custos</h2>
          <p className="text-sm text-muted-foreground">
            Custo que o Bureau paga por produto. Sem override, vale o custo padrão.
          </p>
          <BureauCostsPanel bureauId={bureau.id} rows={costs} />
        </section>
      )}
    </div>
  );
}
