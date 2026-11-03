import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ChevronDown, PackageOpen, ScanSearch, UserRound } from "lucide-react";

import { BrandLogo } from "@/components/portal/brand-logo";
import { PUBLIC_H2, PUBLIC_SECTION, PublicHowItWorks } from "@/components/portal/public-how-it-works";
import { EmptyState } from "@/components/ui/empty-state";
import { Toaster } from "@/components/ui/toaster";
import { getPublicBureau, getPublicCatalog } from "@/lib/bureaus/public";
import { productCopy } from "@/lib/catalog/product-copy";
import { formatCurrency } from "@/lib/utils";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Rainha Cred",
};

const CTA_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-cta px-[26px] py-[15px] font-[family-name:system-ui,sans-serif] text-[15px] font-bold leading-none text-cta-foreground hover:bg-cta-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold-light";
const NOTE_CLASS = "my-4 border-l-[3px] border-brand-gold py-1 pl-[14px] text-muted-foreground";
const SERIF = "font-heading";
const RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

// Cartão claro (creme) para Pessoa Física e demais códigos; escuro (verde) para Empresarial.
const CARD_THEME = {
  light: {
    card: "border-brand-gold bg-brand-cream text-foreground",
    badge: "bg-brand-deep text-brand-gold-light",
    name: "text-brand-deep",
    price: "text-brand-deep",
    muted: "text-muted-foreground",
    divider: "border-[#cfa968]/50",
    summary: `text-primary hover:bg-[#05261f]/5 ${RING} focus-visible:outline-brand-deep`,
    list: "text-foreground",
  },
  dark: {
    card: "border-primary bg-brand-deep text-brand-cream",
    badge: "bg-brand-gold text-brand-deep",
    name: "text-brand-cream",
    price: "text-brand-gold-light",
    muted: "text-[#c9d9d3]",
    divider: "border-[#cfa968]/40",
    summary: `text-brand-gold-light hover:bg-white/5 ${RING} focus-visible:outline-brand-gold-light`,
    list: "text-brand-cream",
  },
} as const;
const PRODUCT_ORDER = ["dossie_pf", "dossie_empresarial"];

// Pessoa Física antes de Empresarial; outros códigos depois, na ordem do banco (sort é estável).
function productRank(code: string): number {
  const i = PRODUCT_ORDER.indexOf(code);
  return i === -1 ? PRODUCT_ORDER.length : i;
}

export default async function PublicBureauPage({
  params,
}: {
  params: { slug: string };
}) {
  const bureau = await getPublicBureau(params.slug);
  if (!bureau) notFound();
  const catalog = (await getPublicCatalog(params.slug)).sort((a, b) => productRank(a.code) - productRank(b.code));

  const start = `/b/${bureau.slug}/entrar`;

  return (
    <main className="area-portal min-h-screen bg-background text-foreground">
      <div className="bg-brand-deep px-4 pb-9 pt-10 text-center text-brand-cream sm:px-7">
        <div className="mx-auto max-w-[760px]">
          <div className="mb-[18px] flex flex-col items-center gap-3">
            <BrandLogo variant="full" tone="light" />
            <p className="max-w-full break-words font-[family-name:system-ui,sans-serif] text-[11px] font-semibold uppercase leading-none tracking-[0.2em] text-brand-gold">
              {bureau.name}
            </p>
          </div>
          <h1 className={`${SERIF} mb-[14px] text-[30px] font-semibold leading-[1.2] text-white`}>
            Você já sabe que tem algo travando seu crédito.{" "}
            <span className="text-brand-gold-light">Falta alguém te mostrar a saída.</span>
          </h1>
          <p className="mx-auto mb-[22px] max-w-[560px] font-[family-name:system-ui,sans-serif] text-base leading-[1.55] text-[#d9e6e1]">
            O Dossiê da Rainha Cred mostra todos os pontos cegos do seu CPF e do seu CNPJ e entrega um plano estratégico para você chegar ao crédito.
          </p>
          <Link href={start} className={CTA_CLASS}>
            Quero meu dossiê
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-[760px]">
        <section className={PUBLIC_SECTION}>
          <p className="mb-[10px]">
            Você está cansado de saber que tem algum apontamento, uma restrição. Já foi atrás de pesquisa, já fez consulta. Sabe que tem uma dificuldade, ou desconfia que o banco está te travando por algum problema.
          </p>
          <p className="mb-[10px] font-bold text-brand-deep">
            Só que ninguém te mostra o caminho. Ninguém te mostra um plano. Ninguém te mostra a saída.
          </p>
        </section>

        <section className={PUBLIC_SECTION}>
          <div className="mb-3 mt-2 flex flex-col gap-3 sm:flex-row rounded-2xl bg-brand-deep px-[22px] py-5 text-brand-cream shadow-[0_6px_20px_rgba(5,38,31,0.18)]">
            <ScanSearch aria-hidden className="size-6 shrink-0 text-brand-gold sm:mt-1" />
            <div>
            <p className="mb-[10px]">
              Este dossiê faz as duas coisas. Primeiro, mostra <b className="text-brand-gold-light">tudo o que atrapalha o seu crédito</b>, no CPF e no CNPJ, inclusive o que você não sabia que existia.
            </p>
            <p>
              Depois, com o conhecimento de <b className="text-brand-gold-light">16 anos da Rainha Cred</b> e o apoio da inteligência artificial, traça <b className="text-brand-gold-light">um caminho seguro e eficiente</b> até o seu objetivo de crédito.
            </p>
            </div>
          </div>
        </section>

        <section className={PUBLIC_SECTION}>
          <h2 className={PUBLIC_H2}>Qual dossiê escolher</h2>
          <p className={NOTE_CLASS}>
            Todo CNPJ tem um ou mais CPFs por trás, e o banco olha os dois. Por isso a análise da empresa inclui os sócios e, quando o casamento é com comunhão de bens, os cônjuges. Se o sócio tem mais de uma empresa, analise o grupo inteiro: é o cruzamento dos dados que dá um parecer técnico preciso.
          </p>
          <p className={NOTE_CLASS}>É como um exame de sangue: um dossiê por pessoa e um por empresa.</p>
          {catalog.length === 0 ? (
            <EmptyState icon={PackageOpen} title="Catálogo em breve" description="Este Bureau ainda não colocou pesquisas à venda." />
          ) : (
            <>
              {catalog.map((item) => {
                const copy = productCopy(item.code);
                const isCompany = item.code === "dossie_empresarial";
                const t = CARD_THEME[isCompany ? "dark" : "light"];
                const Icon = isCompany ? Building2 : UserRound;
                const hasPartner = Number(item.salePricePerPartner) > 0;
                return (
                  <div key={item.code} className={`my-4 rounded-2xl border px-5 py-5 shadow-[0_6px_20px_rgba(5,38,31,0.12)] ${t.card}`}>
                    <div className="flex items-center gap-3">
                      <span aria-hidden className={`flex size-11 shrink-0 items-center justify-center rounded-full ${t.badge}`}>
                        <Icon className="size-5" />
                      </span>
                      <h3 className={`${SERIF} min-w-0 break-words text-[22px] font-bold leading-[1.25] ${t.name}`}>{item.name}</h3>
                    </div>
                    <p className={`mt-4 font-[family-name:system-ui,sans-serif] tabular-nums ${t.price}`}>
                      <span className="text-[34px] font-extrabold leading-none">{formatCurrency(Number(item.salePrice))}</span>
                      {hasPartner && <span className={`ml-2 text-sm font-normal ${t.muted}`}>por empresa</span>}
                      {hasPartner && (
                        <span className={`mt-1 block text-sm font-normal ${t.muted}`}>
                          + {formatCurrency(Number(item.salePricePerPartner))} por sócio ou cônjuge
                        </span>
                      )}
                    </p>
                    {copy && (
                      <>
                        <p className={`mt-3 text-sm leading-[1.55] ${t.muted}`}>{copy.summary}</p>
                        <details className={`group mt-4 border-t ${t.divider}`}>
                          <summary
                            className={`-mx-2 mt-1 flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 font-[family-name:system-ui,sans-serif] text-sm font-bold [&::-webkit-details-marker]:hidden ${t.summary}`}
                          >
                            O que você recebe
                            <ChevronDown aria-hidden className="size-5 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
                          </summary>
                          <ul className={`list-disc space-y-1 pb-1 pl-5 pt-1 text-sm ${t.list}`}>
                            {copy.includes.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      </>
                    )}
                  </div>
                );
              })}
              <p className="my-4">
                <b>O parecer da Rainha Cred vem em todo dossiê, sem custo extra.</b> Referência nacional, com 16 anos de mercado e mais de R$ 500 milhões em crédito aprovado. O método dela, aplicado à sua situação, em linguagem simples.
              </p>
              <p className="my-4 text-sm text-[#5b706b]">
                O parecer é gerado com apoio de inteligência artificial, seguindo o método da Rainha Cred.
              </p>
            </>
          )}
        </section>

        <PublicHowItWorks />
      </div>

      <div className="mt-5 bg-brand-deep p-7 text-center text-brand-cream">
        <p className="mb-4 font-[family-name:system-ui,sans-serif] text-base leading-[1.5]">
          Pare de pedir crédito no escuro. Veja o que trava o seu crédito e saia com o plano para chegar lá.
        </p>
        <Link href={start} className={CTA_CLASS}>
          Quero meu dossiê
        </Link>
      </div>
      <Toaster />
    </main>
  );
}
