import { AcceptLegalForm } from "@/components/legal/accept-legal-form";
import { LegalDocumentView } from "@/components/legal/legal-document";
import { getCurrentLegalDocuments } from "@/lib/account/queries";

export const dynamic = "force-dynamic";

export const metadata = { title: "Termos de uso" };

export default async function AcceptTermsPage() {
  const { terms, privacy } = await getCurrentLegalDocuments();
  return (
    <div className="space-y-10 rounded-md border bg-background p-6">
      <LegalDocumentView document={terms} />
      <LegalDocumentView document={privacy} />
      <AcceptLegalForm termsVersion={terms.version} privacyVersion={privacy.version} />
    </div>
  );
}
