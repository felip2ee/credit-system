import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ChevronDown, ScanSearch, UserRound, type LucideIcon } from "lucide-react";

import { PUBLIC_H2, PublicHowItWorks, SECTION_ALT, SECTION_DEEP, YELLOW } from "@/components/portal/public-how-it-works";
import { Toaster } from "@/components/ui/toaster";
import { getPublicBureau, getPublicCatalog } from "@/lib/bureaus/public";
import { formatCurrency } from "@/lib/utils";

// Reads the DB without cookies/headers: without this Next may cache a 404 for a new slug or a stale bureau name.
export const dynamic = "force-dynamic";

// Same generic title for existing and unknown slugs: no enumeration signal.
export const metadata = {
  title: "Rainha Cred",
};

const CTA_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--landing-yellow)] bg-[var(--landing-yellow)] px-[26px] py-[15px] font-[family-name:system-ui,sans-serif] text-[15px] font-bold leading-none text-[var(--landing-green)] hover:border-[var(--landing-yellow-hover)] hover:bg-[var(--landing-yellow-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const NOTE_CLASS = "my-4 border-l-[3px] border-[var(--landing-yellow)] py-1 pl-[14px] text-white";
const SERIF = "font-heading";
const RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

// Cartões no verde alternado com borda amarela, sobre a seção deep.
const CARD_THEME = {
  light: {
    card: "border-[var(--landing-yellow)] bg-[var(--landing-green-alt)] text-white",
    divider: "border-[var(--landing-yellow)]/60",
  },
  dark: {
    card: "border-[var(--landing-yellow)] bg-[var(--landing-green-alt)] text-white",
    divider: "border-[var(--landing-yellow)]/60",
  },
} as const;

const PF_INCLUDES = [
  "Análise do seu CPF no sistema financeiro, incluindo informações disponíveis sobre operações de crédito no Sistema de Informações de Crédito do Banco Central (SCR).",
  "Identificação de pontos de atenção que podem comprometer sua avaliação pelas instituições financeiras.",
  "Análise do seu perfil de crédito, considerando os dados disponíveis e os critérios utilizados na avaliação financeira.",
  "Parecer estratégico da Rainha do Crédito, com prioridades organizadas para orientar suas próximas decisões.",
  "Relatório digital disponível na plataforma Rainha Cred e em PDF.",
  "Notificação por e-mail e WhatsApp quando o relatório estiver disponível.",
];
const COMPANY_INCLUDES = [
  "Análise do CNPJ no sistema financeiro, considerando as informações disponíveis sobre operações de crédito.",
  "Análise individual dos sócios e, quando aplicável, dos cônjuges incluídos na avaliação.",
  "Cruzamento das informações disponíveis para identificar possíveis fatores que estejam comprometendo o perfil de crédito da empresa.",
  "Identificação dos principais pontos de atenção e das prioridades para melhorar o posicionamento financeiro empresarial.",
  "Parecer estratégico da Rainha do Crédito, com orientações organizadas para direcionar as próximas decisões.",
  "Relatório digital disponível na plataforma Rainha Cred e em PDF.",
  "Notificação por e-mail e WhatsApp quando o relatório estiver disponível.",
];

function DossierCard({
  variant,
  icon: Icon,
  title,
  price,
  intro,
  includes,
}: {
  variant: keyof typeof CARD_THEME;
  icon: LucideIcon;
  title: string;
  price: ReactNode;
  intro: string[];
  includes: string[];
}) {
  const t = CARD_THEME[variant];
  return (
    <div className={`my-4 rounded-2xl border px-5 py-5 ${t.card}`}>
      <div className="flex items-center gap-3">
        <span aria-hidden className={`flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--landing-yellow)] text-[var(--landing-green)]`}>
          <Icon className="size-5" />
        </span>
        <h3 className={`${SERIF} min-w-0 break-words text-[22px] font-bold uppercase leading-[1.25] ${YELLOW}`}>{title}</h3>
      </div>
      {price && <p className={`mt-4 font-[family-name:system-ui,sans-serif] text-lg tabular-nums ${YELLOW}`}>{price}</p>}
      <div className={`mt-3 space-y-2 text-sm leading-[1.55] text-white`}>
        {intro.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <details className={`group mt-4 border-t ${t.divider}`}>
        <summary
          className={`-mx-2 mt-1 flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 font-[family-name:system-ui,sans-serif] text-sm font-bold ${YELLOW} hover:bg-white/10 ${RING} focus-visible:outline-white [&::-webkit-details-marker]:hidden`}
        >
          O que você recebe:
          <ChevronDown aria-hidden className="size-5 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <ul className={`list-disc space-y-1 pb-1 pl-5 pt-1 text-sm text-white`}>
          {includes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export default async function PublicBureauPage({
  params,
}: {
  params: { slug: string };
}) {
  const bureau = await getPublicBureau(params.slug);
  if (!bureau) notFound();
  const catalog = await getPublicCatalog(params.slug);
  const pf = catalog.find((item) => item.code === "dossie_pf");
  const company = catalog.find((item) => item.code === "dossie_empresarial");

  const start = `/b/${bureau.slug}/entrar`;

  return (
    <main className="landing area-portal min-h-screen bg-[var(--landing-green)] text-white">
      <div className="bg-[var(--landing-green)] px-4 pb-9 pt-10 text-center text-white sm:px-7">
        <div className="mx-auto max-w-[760px]">
          <p className="mb-[18px] max-w-full break-words font-[family-name:system-ui,sans-serif] text-lg font-bold uppercase leading-tight tracking-[0.18em] text-[var(--landing-yellow)] sm:text-2xl">
            {bureau.name}
          </p>
          <h1 className={`${SERIF} mb-[14px] text-[30px] font-semibold leading-[1.2] text-[var(--landing-yellow)]`}>
            Conheça o que está impedindo seu acesso ao crédito.{" "}
            <span>Descubra o caminho para mudar essa realidade.</span>
          </h1>
          <div className="mx-auto mb-[22px] max-w-[560px] space-y-3 text-left font-[family-name:system-ui,sans-serif] text-base leading-[1.55] text-white">
            <p>
              Você sabe que existe algo dificultando seu acesso ao crédito, mas talvez ainda não saiba exatamente o que está comprometendo sua análise financeira.
            </p>
            <p>
              O Dossiê da Rainha Cred foi desenvolvido para identificar fatores que podem limitar seu acesso ao crédito, tanto no CPF quanto no CNPJ, e apresentar um direcionamento estratégico para melhorar seu posicionamento perante o sistema financeiro.
            </p>
            <p>
              Mais do que consultar informações, você terá uma análise estruturada da sua situação e um parecer estratégico da Rainha do Crédito, com orientações para compreender o que merece atenção antes de buscar novas oportunidades de crédito.
            </p>
            <p className="font-bold text-[var(--landing-yellow)]">
              Informação, estratégia e inteligência para tomar decisões mais conscientes.
            </p>
          </div>
          <Link href={start} className={CTA_CLASS}>
            QUERO CONHECER MEU DOSSIÊ
          </Link>
        </div>
      </div>

      <div>
        <section className={SECTION_ALT}>
          <h2 className={PUBLIC_H2}>Por que você pode estar tendo dificuldades para conseguir crédito?</h2>
          <p className="mb-[10px]">
            Você já consultou seu CPF ou CNPJ, verificou possíveis restrições e tentou entender por que as instituições financeiras não aprovam suas solicitações.
          </p>
          <p className={`mb-[10px] font-bold ${YELLOW}`}>Mesmo assim, continua sem respostas claras.</p>
          <p className="mb-[10px]">
            O problema é que nem sempre os fatores que comprometem o acesso ao crédito são evidentes. Existem informações no histórico financeiro, no relacionamento com o sistema bancário e na estrutura cadastral que podem influenciar a avaliação das instituições financeiras.
          </p>
          <p className="mb-[10px]">
            Sem conhecer esses fatores, você corre o risco de continuar solicitando crédito sem compreender o que precisa ser corrigido.
          </p>
          <p className={`mb-[10px] font-bold ${YELLOW}`}>
            O primeiro passo para mudar esse cenário é conhecer sua realidade financeira.
          </p>
          <div className="mb-3 mt-4 flex flex-col gap-3 rounded-2xl border border-[var(--landing-yellow)] bg-[var(--landing-green)] px-[22px] py-5 text-white sm:flex-row">
            <ScanSearch aria-hidden className="size-6 shrink-0 text-[var(--landing-yellow)] sm:mt-1" />
            <div className="space-y-[10px]">
              <p>
                O Dossiê da Rainha Cred reúne informações relevantes sobre seu perfil financeiro, identifica pontos que merecem atenção e apresenta um direcionamento estratégico desenvolvido a partir da metodologia da Rainha do Crédito.
              </p>
              <p>
                Com 16 anos de experiência no mercado de crédito, a Rainha do Crédito utiliza conhecimento especializado e recursos de inteligência artificial para transformar informações financeiras em orientações claras e organizadas.
              </p>
            </div>
          </div>
        </section>

        <section className={SECTION_DEEP}>
          <h2 className={PUBLIC_H2}>Qual dossiê é ideal para você?</h2>
          <p className="mb-[10px]">
            Uma análise eficiente precisa considerar não apenas a empresa, mas também as pessoas que fazem parte da sua estrutura societária.
          </p>
          <p className="mb-[10px]">
            Isso porque a avaliação de crédito empresarial pode considerar informações relacionadas aos sócios e, conforme a operação e as políticas da instituição financeira, outros fatores vinculados à estrutura patrimonial e financeira.
          </p>
          <p className="mb-[10px]">Por isso, desenvolvemos duas modalidades de análise.</p>

          <DossierCard
            variant="light"
            icon={UserRound}
            title="Dossiê Pessoa Física"
            price={pf ? <>Investimento: <b>{formatCurrency(Number(pf.salePrice))}</b></> : null}
            intro={[
              "Conheça os fatores que podem influenciar sua capacidade de obter crédito e receba um direcionamento estratégico para melhorar seu posicionamento financeiro.",
            ]}
            includes={PF_INCLUDES}
          />

          <DossierCard
            variant="dark"
            icon={Building2}
            title="Dossiê Empresarial"
            price={
              company ? (
                <>
                  Investimento: <b>{formatCurrency(Number(company.salePrice))}</b> por empresa
                  {Number(company.salePricePerPartner) > 0 && (
                    <>, acrescido de <b>{formatCurrency(Number(company.salePricePerPartner))}</b> por sócio ou cônjuge incluído na análise.</>
                  )}
                </>
              ) : null
            }
            intro={[
              "Sua empresa não deve ser analisada de forma isolada. É importante compreender também os fatores relacionados às pessoas que integram sua estrutura empresarial.",
              "O Dossiê Empresarial oferece uma visão integrada da situação financeira da empresa e das pessoas envolvidas na análise.",
            ]}
            includes={COMPANY_INCLUDES}
          />
          <p className={NOTE_CLASS}>
            <b>IMPORTANTE:</b> Cada pessoa incluída na análise deverá autorizar individualmente a consulta aos seus dados.
          </p>
        </section>

        <section className={SECTION_ALT}>
          <h2 className={PUBLIC_H2}>O diferencial: parecer estratégico da Rainha do Crédito</h2>
          <p className="mb-[10px]">Ao contratar seu dossiê, você não recebe apenas um relatório com informações financeiras.</p>
          <p className="mb-[10px]">
            Você recebe um Parecer Estratégico da Rainha do Crédito, desenvolvido com base em uma metodologia própria e em 16 anos de experiência no mercado de crédito.
          </p>
          <p className="mb-[10px]">
            A análise utiliza recursos de inteligência artificial como ferramenta de apoio para organizar informações, identificar pontos de atenção e estruturar um direcionamento estratégico.
          </p>
          <p className="mb-[10px]">
            O resultado é uma avaliação que apresenta os principais aspectos que merecem atenção no seu perfil financeiro, além de orientações para que você compreenda melhor sua situação e saiba quais caminhos considerar para melhorar seu posicionamento perante o mercado financeiro.
          </p>
          <p className={`mb-[10px] font-bold ${YELLOW}`}>
            A tecnologia organiza as informações. A experiência e o conhecimento da Rainha do Crédito transformam essas informações em estratégia.
          </p>
          <p className="mb-[10px]">
            A plataforma Rainha Cred proporciona o ambiente digital para que você tenha acesso ao seu dossiê de forma prática e organizada.
          </p>
        </section>

        <PublicHowItWorks />
      </div>

      <div className="border-t border-[var(--landing-yellow)] bg-[var(--landing-green)] px-4 py-9 text-center text-white sm:px-7">
        <div className="mx-auto max-w-[760px] space-y-3 font-[family-name:system-ui,sans-serif] text-base leading-[1.55]">
          <h2 className={`${SERIF} text-[24px] font-bold uppercase leading-[1.25] text-[var(--landing-yellow)]`}>
            Não tome decisões de crédito sem conhecer sua realidade financeira.
          </h2>
          <p>O acesso ao crédito começa muito antes de uma solicitação ao banco.</p>
          <p className="font-bold text-[var(--landing-yellow)]">Começa com informação, diagnóstico e estratégia.</p>
          <p>
            Conheça os fatores que podem estar comprometendo seu perfil financeiro e tenha um direcionamento para construir uma jornada de crédito mais consciente e planejada.
          </p>
          <p>Rainha do Crédito. Conhecimento, inteligência e estratégia para transformar sua relação com o crédito.</p>
          <p className="mb-4">Acesse a plataforma Rainha Cred e solicite seu dossiê.</p>
          <Link href={start} className={CTA_CLASS}>
            QUERO SOLICITAR MEU DOSSIÊ
          </Link>
        </div>
      </div>
      <Toaster />
    </main>
  );
}
