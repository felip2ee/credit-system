import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHeader } from "@/components/layout/page-header";
import { BureauEditForm } from "@/components/superadmin/bureau-edit-form";
import { InviteAdminForm } from "@/components/superadmin/invite-admin-form";
import { SupportStartForm } from "@/components/superadmin/support-start-form";
import { getRequiredSession } from "@/lib/auth/session";
import { getBureau } from "@/lib/bureaus/queries";

export const metadata = { title: "Bureau" };

export default async function BureauDetailPage({ params }: { params: { id: string } }) {
  if (!z.string().uuid().safeParse(params.id).success) notFound();
  const session = await getRequiredSession();
  const bureau = await getBureau(session, params.id);
  if (!bureau) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={bureau.name} description={`Endereço público: /b/${bureau.slug}`} />
      <BureauEditForm bureau={bureau} />
      <InviteAdminForm bureauId={bureau.id} />
      <SupportStartForm bureauId={bureau.id} />
    </div>
  );
}
