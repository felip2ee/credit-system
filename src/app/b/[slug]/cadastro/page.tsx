import { notFound, permanentRedirect } from "next/navigation";

import { PublicShell } from "@/components/portal/public-shell";
import { RegisterForm } from "@/components/register/register-form";
import { getCurrentLegalDocuments } from "@/lib/account/queries";
import { resolveBureauSlug } from "@/lib/bureaus/public";

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
  const resolved = await resolveBureauSlug(params.slug);
  if (resolved.kind === "redirect") {
    const ref = typeof searchParams.ref === "string" ? `?ref=${encodeURIComponent(searchParams.ref)}` : "";
    permanentRedirect(`/b/${resolved.slug}/cadastro${ref}`);
  }
  if (resolved.kind === "missing") notFound();
  const { bureau } = resolved;
  const legal = await getCurrentLegalDocuments();

  return (
    <PublicShell bureauName={bureau.name}>
      <RegisterForm
        slug={bureau.slug}
        termsVersion={legal.terms.version}
        privacyVersion={legal.privacy.version}
        referralCode={typeof searchParams.ref === "string" ? searchParams.ref : undefined}
      />
    </PublicShell>
  );
}
