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
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <LegalDocumentView document={privacy} />
    </main>
  );
}
