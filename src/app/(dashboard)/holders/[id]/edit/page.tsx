import { notFound, redirect } from "next/navigation";

import { HolderForm } from "@/components/holders/holder-form";
import { PageHeader } from "@/components/layout/page-header";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { getHolderDetail } from "@/lib/holders/queries";
import { isUuid } from "@/lib/validators/id";

export default async function EditHolderPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound();
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "holders:write")) redirect(`/holders/${params.id}`);
  const detail = await getHolderDetail(session, params.id);
  if (!detail) notFound();

  return (
    <div className="max-w-3xl">
      <PageHeader title="Editar titular" description={detail.holder.name} />
      <HolderForm initial={detail.holder} />
    </div>
  );
}
