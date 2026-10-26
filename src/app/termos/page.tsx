import { PublicShell } from "@/components/portal/public-shell";
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
      <LegalDocumentView document={terms} />
    </PublicShell>
  );
}
