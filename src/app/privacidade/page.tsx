import { PublicShell } from "@/components/portal/public-shell";
import { ScreenHeader } from "@/components/ui/screen-header";
import { LegalDocumentView } from "@/components/legal/legal-document";
import { getCurrentLegalDocuments } from "@/lib/account/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { privacy } = await getCurrentLegalDocuments();
  return { title: privacy.title };
}

export default async function LegalPage() {
  const { privacy } = await getCurrentLegalDocuments();
  return (
    <PublicShell width="3xl">
      <ScreenHeader className="-mx-4 min-[375px]:-mx-5" title={privacy.title} />
      <p className="text-base text-muted-foreground">Você pode fechar esta aba para voltar ao cadastro.</p>
      <LegalDocumentView document={privacy} hideTitle />
    </PublicShell>
  );
}
