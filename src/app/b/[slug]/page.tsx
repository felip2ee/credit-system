import { notFound, redirect } from "next/navigation";
import { Fraunces, Inter } from "next/font/google";

import { LandingFinalCta, LandingFooter } from "@/components/portal/landing/landing-closing";
import { LandingDossiers, LandingWhy } from "@/components/portal/landing/landing-dossiers";
import { LandingHeader, LandingHero } from "@/components/portal/landing/landing-hero";
import { LandingDifferential, LandingFaq, LandingSteps } from "@/components/portal/landing/landing-trust";
import { Toaster } from "@/components/ui/toaster";
import { bufferBureauVisit } from "@/lib/bureau-admin/visit-buffer";
import { getPublicCatalog, resolveBureauSlug } from "@/lib/bureaus/public";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Rainha Cred",
};

// Fontes só desta rota: as variáveis CSS ficam no wrapper da landing.
const serif = Fraunces({ subsets: ["latin"], weight: ["500", "700"], style: ["normal", "italic"], display: "swap", variable: "--font-landing-serif" });
const sans = Inter({ subsets: ["latin"], display: "swap", variable: "--font-landing-sans" });

export default async function PublicBureauPage({
  params,
}: {
  params: { slug: string };
}) {
  const resolved = await resolveBureauSlug(params.slug);
  if (resolved.kind === "redirect") redirect(`/b/${resolved.slug}`);
  if (resolved.kind === "missing") notFound();
  const { bureau } = resolved;
  // Em memória e síncrona: o banco só é tocado no flush em lote, nunca no render.
  bufferBureauVisit(bureau.slug);
  const catalog = await getPublicCatalog(params.slug);
  const pf = catalog.find((item) => item.code === "dossie_pf");
  const company = catalog.find((item) => item.code === "dossie_empresarial");

  const start = `/b/${bureau.slug}/entrar`;

  return (
    <div className={`landing ${serif.variable} ${sans.variable} min-h-screen`}>
      <LandingHeader href={start} />
      <main>
        <LandingHero href={start} />
        <LandingWhy />
        <LandingDossiers
          href={start}
          pfPrice={pf ? Number(pf.salePrice) : undefined}
          companyPrice={company ? Number(company.salePrice) : undefined}
          partnerPrice={company ? Number(company.salePricePerPartner) : undefined}
        />
        <LandingDifferential />
        <LandingSteps />
        <LandingFaq />
        <LandingFinalCta href={start} />
      </main>
      <LandingFooter />
      <Toaster />
    </div>
  );
}
