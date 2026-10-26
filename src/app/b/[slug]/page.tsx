import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ChevronDown, PackageOpen, UserRound } from "lucide-react";

import { PublicHowItWorks } from "@/components/portal/public-how-it-works";
import { PublicShell } from "@/components/portal/public-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { getPublicBureau, getPublicCatalog } from "@/lib/bureaus/public";
import { productCopy } from "@/lib/catalog/product-copy";
import { formatCurrency } from "@/lib/utils";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Rainha Cred",
};

export default async function PublicBureauPage({
  params,
}: {
  params: { slug: string };
}) {
  const bureau = await getPublicBureau(params.slug);
  if (!bureau) notFound();
  const catalog = await getPublicCatalog(params.slug);

  const start = `/b/${bureau.slug}/entrar`;

  return (
    <PublicShell
      bureauName={bureau.name}
      hero={
        <section className="space-y-3">
          <h1 className="text-2xl font-bold">Seu crédito é negado e você não sabe por quê?</h1>
          <p>
            Muitas vezes o problema está em pontos ocultos que você não enxerga. O dossiê é como um exame médico do seu crédito: mostra a sua situação atual, o seu teto de crédito e o que vem atrapalhando, com parecer pela metodologia da Rainha Cred e orientações, tudo incluso.
          </p>
          <Button asChild size="lg" className="w-full rounded-full bg-white font-bold text-primary hover:bg-white/90">
            <Link href={start}>Começar agora</Link>
          </Button>
        </section>
      }
    >
      <div className="space-y-6">
        <p className="text-muted-foreground">
          Para empresas, todos os sócios pesam na decisão do banco, por isso a análise inclui cada um deles. A consulta é só em seu nome e nos CNPJs das suas empresas, nunca de terceiros.
        </p>
        <section className="space-y-3">
          <SectionHeader title="Qual dossiê escolher" />
          {catalog.length === 0 ? (
            <EmptyState icon={PackageOpen} title="Catálogo em breve" description="Este Bureau ainda não colocou pesquisas à venda." />
          ) : (
            <>
              {catalog.map((item) => {
                const copy = productCopy(item.code);
                return (
                  <Card key={item.code} className="space-y-2 p-4">
                    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
                      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-primary">
                        {item.code === "dossie_empresarial" ? <Building2 className="size-5" /> : <UserRound className="size-5" />}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-base font-bold">{item.name}</span>
                    </div>
                    <p className="px-4 font-bold tabular-nums">
                      {Number(item.salePricePerPartner) > 0 ? (
                        <>
                          {formatCurrency(Number(item.salePrice))} por empresa
                          <br />+ {formatCurrency(Number(item.salePricePerPartner))} por sócio
                        </>
                      ) : (
                        formatCurrency(Number(item.salePrice))
                      )}
                    </p>
                    {copy && (
                      <>
                        <p className="px-4 text-sm">{copy.summary}</p>
                        <details className="group px-4">
                          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold text-primary [&::-webkit-details-marker]:hidden">
                            O que você recebe
                            <ChevronDown aria-hidden className="size-5 shrink-0 transition-transform group-open:rotate-180" />
                          </summary>
                          <ul className="list-disc space-y-1 pb-2 pl-5 text-sm text-muted-foreground">
                            {copy.includes.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      </>
                    )}
                  </Card>
                );
              })}
              <div className="space-y-2 rounded-lg bg-muted p-4 text-sm">
                <p className="font-bold">Parecer com a metodologia da Rainha Cred, incluso em todo dossiê</p>
                <p>
                  Referência nacional, com 16 anos de mercado e mais de R$ 500 milhões em crédito aprovado. Uma metodologia validada, aplicada à sua
                  situação, com pontos de atenção e próximos passos em linguagem simples. Sem custo extra.
                </p>
                <p className="text-xs text-muted-foreground">
                  O parecer é gerado com apoio de inteligência artificial, seguindo a metodologia da Rainha Cred.
                </p>
              </div>
            </>
          )}
        </section>
        <PublicHowItWorks />
        <Button asChild size="lg" glow className="w-full">
          <Link href={start}>Começar agora</Link>
        </Button>
      </div>
    </PublicShell>
  );
}
