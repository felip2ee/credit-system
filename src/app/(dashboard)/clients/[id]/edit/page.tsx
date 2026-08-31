import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "@/components/clients/client-form";
import { getRequiredSession } from "@/lib/auth/session";
import { getClientForEdit } from "@/lib/clients/queries";

export default async function EditClientPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  const client = await getClientForEdit(session, params.id);

  if (!client) notFound();

  return (
    <div className="max-w-3xl">
      <PageHeader title="Editar cliente" description={client.name} />
      <ClientForm initial={client} />
    </div>
  );
}
