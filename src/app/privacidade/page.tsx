import { PublicShell } from "@/components/portal/public-shell";
import { LegalBackHeader } from "@/components/register/legal-back-header";
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
      <LegalBackHeader title={privacy.title} />
      <LegalDocumentView document={privacy} hideTitle />
    </PublicShell>
  );
}
