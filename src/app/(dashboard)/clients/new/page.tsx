import { PageHeader } from "@/components/layout/page-header";
import { ClientForm } from "@/components/clients/client-form";

export default function NewClientPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Novo cliente"
        description="Cadastre uma pessoa física ou jurídica"
      />
      <ClientForm />
    </div>
  );
}
