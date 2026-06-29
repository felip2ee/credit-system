import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "@/components/clients/client-form";
import { createClient } from "@/lib/supabase/server";
import type { CrmClient } from "@/types/app";

export default async function EditClientPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const { data } = await supabase
    .from("crm_clients")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!data) notFound();

  return (
    <div className="max-w-3xl">
      <PageHeader title="Editar cliente" description={(data as CrmClient).name} />
      <ClientForm initial={data as CrmClient} />
    </div>
  );
}
