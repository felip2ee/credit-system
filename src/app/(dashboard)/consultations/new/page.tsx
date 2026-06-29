import { PageHeader } from "@/components/layout/page-header";
import { ConsultationForm } from "@/components/consultations/consultation-form";

export default function NewConsultationPage() {
  return (
    <div>
      <PageHeader
        title="Nova consulta"
        description="Consulte um cliente no bureau (deps.com.br)"
      />
      <ConsultationForm />
    </div>
  );
}
