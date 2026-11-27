import { PublicShell } from "@/components/portal/public-shell";
import { LegalBackHeader } from "@/components/register/legal-back-header";
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
      <LegalBackHeader title={terms.title} />
      <LegalDocumentView document={terms} hideTitle />
    </PublicShell>
  );
}
