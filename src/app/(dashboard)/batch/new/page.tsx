import { PageHeader } from "@/components/layout/page-header";
import { CompanyProcessForm } from "@/components/batch/company-process-form";

export default function NewBatchPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Novo processo de empresa"
        description="Informe o CNPJ e os CPFs dos sócios a consultar em conjunto"
      />
      <CompanyProcessForm />
    </div>
  );
}
