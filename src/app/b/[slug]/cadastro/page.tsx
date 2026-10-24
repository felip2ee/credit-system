import { notFound } from "next/navigation";

import { RegisterForm } from "@/components/register/register-form";
import { getCurrentLegalDocuments } from "@/lib/account/queries";
import { getPublicBureau } from "@/lib/bureaus/public";

export const dynamic = "force-dynamic";

// Mesmo título genérico de /b/[slug]: sem sinal de enumeração.
export const metadata = {
  title: "Rainha Cred",
};

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { ref?: string | string[] };
}) {
  const bureau = await getPublicBureau(params.slug);
  if (!bureau) notFound();
  const legal = await getCurrentLegalDocuments();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <RegisterForm
        slug={bureau.slug}
        bureauName={bureau.name}
        termsVersion={legal.terms.version}
        privacyVersion={legal.privacy.version}
        referralCode={typeof searchParams.ref === "string" ? searchParams.ref : undefined}
      />
    </main>
  );
}
