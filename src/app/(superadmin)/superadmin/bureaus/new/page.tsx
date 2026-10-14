import { PageHeader } from "@/components/layout/page-header";
import { BureauCreateForm } from "@/components/superadmin/bureau-create-form";

export const metadata = { title: "Novo Bureau" };

export default function NewBureauPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Novo Bureau"
        description="Cria o Bureau e envia o convite ao primeiro administrador"
      />
      <BureauCreateForm />
    </div>
  );
}
