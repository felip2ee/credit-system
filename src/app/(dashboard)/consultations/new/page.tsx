import { PageHeader } from "@/components/layout/page-header";
import { ConsultationForm } from "@/components/consultations/consultation-form";
import { depsProductName } from "@/lib/deps/products";

export default function NewConsultationPage() {
  const productNames = { PF: depsProductName("PF"), PJ: depsProductName("PJ") };
  return (
    <div>
      <PageHeader
        title="Consulta PF/PJ"
        description="Consulte um titular no bureau (deps.com.br)"
      />
      <ConsultationForm productNames={productNames} />
    </div>
  );
}
