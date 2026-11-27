import { PublicShell } from "@/components/portal/public-shell";
import { ScreenHeader } from "@/components/ui/screen-header";
import { LegalDocumentView } from "@/components/legal/legal-document";
import { getCurrentLegalDocuments } from "@/lib/account/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { terms } = await getCurrentLegalDocuments();
  return { title: terms.title };
}

export default async function LegalPage() {
  const { terms } = await getCurrentLegalDocuments();
  return (
    <PublicShell width="3xl">
      <ScreenHeader className="-mx-4 min-[375px]:-mx-5" title={terms.title} />
      <p className="text-base text-muted-foreground">Você pode fechar esta aba para voltar ao cadastro.</p>
      <LegalDocumentView document={terms} hideTitle />
    </PublicShell>
  );
}
