import Link from "next/link";
import { Check, ScanSearch } from "lucide-react";

import { formatCurrency } from "@/lib/utils";
import { BTN_BASE, CONTAINER, H2, SECTION_X } from "./landing-styles";

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

export function LandingWhy() {
  const pClass = "m-0";
  const keyClass = "m-0 border-l-4 border-[var(--landing-yellow)] pl-[18px] font-semibold text-[var(--landing-green)]";
  return (
    <section className={`${SECTION_X} pb-10 pt-16 lg:pt-24`}>
      <div className={`${CONTAINER} flex flex-col gap-8 lg:flex-row lg:gap-12`}>
        <h2 className={`${H2} lg:flex-[1_1_360px]`}>Por que você pode estar tendo dificuldades para conseguir crédito?</h2>
        <div className="flex min-w-0 flex-col gap-4 text-[17px] leading-[1.7] text-[var(--landing-muted)] lg:flex-[1_1_480px]">
          <p className={pClass}>
            Você já consultou seu CPF ou CNPJ, verificou possíveis restrições e tentou entender por que as instituições financeiras não aprovam suas solicitações.
          </p>
          <p className={keyClass}>Mesmo assim, continua sem respostas claras.</p>
          <p className={pClass}>
            O problema é que nem sempre os fatores que comprometem o acesso ao crédito são evidentes. Existem informações no histórico financeiro, no relacionamento com o sistema bancário e na estrutura cadastral que podem influenciar a avaliação das instituições financeiras.
          </p>
          <p className={pClass}>
            Sem conhecer esses fatores, você corre o risco de continuar solicitando crédito sem compreender o que precisa ser corrigido.
          </p>
          <p className={keyClass}>O primeiro passo para mudar esse cenário é conhecer sua realidade financeira.</p>
          <div className="flex gap-4 rounded-2xl bg-[var(--landing-mint)] p-5 text-[var(--landing-green)]">
            <ScanSearch aria-hidden className="mt-1 size-6 shrink-0" />
            <div className="min-w-0 space-y-3">
              <p>
                O Dossiê da Rainha Cred reúne informações relevantes sobre seu perfil financeiro, identifica pontos que merecem atenção e apresenta um direcionamento estratégico desenvolvido a partir da metodologia da Rainha do Crédito.
              </p>
              <p>
                Com 16 anos de experiência no mercado de crédito, a Rainha do Crédito utiliza conhecimento especializado e recursos de inteligência artificial para transformar informações financeiras em orientações claras e organizadas.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Includes({ items, checkClass }: { items: string[]; checkClass: string }) {
  return (
    <>
      <p className="mb-3 text-base font-bold">O que você recebe:</p>
      <ul className="mb-7 flex flex-col gap-[14px] text-base leading-[1.5]">
        {items.map((line) => (
          <li key={line} className="flex gap-3">
            <Check aria-hidden strokeWidth={2.4} className={`mt-0.5 size-5 shrink-0 ${checkClass}`} />
            <span className="min-w-0">{line}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

const PRICE_CLASS = "lp-serif mb-1 text-[40px] font-bold leading-tight tabular-nums lg:text-[52px]";

export function LandingDossiers({
  href,
  pfPrice,
  companyPrice,
  partnerPrice,
}: {
  href: string;
  pfPrice?: number;
  companyPrice?: number;
  partnerPrice?: number;
}) {
  return (
    <section className={`${SECTION_X} pb-16 pt-14 lg:pb-24`}>
      <div className={CONTAINER}>
        <h2 className={`${H2} mb-3`}>Qual dossiê é ideal para você?</h2>
        <div className="mb-10 max-w-[700px] space-y-3 text-[17px] leading-[1.6] text-[var(--landing-muted)]">
          <p>Uma análise eficiente precisa considerar não apenas a empresa, mas também as pessoas que fazem parte da sua estrutura societária.</p>
          <p>
            Isso porque a avaliação de crédito empresarial pode considerar informações relacionadas aos sócios e, conforme a operação e as políticas da instituição financeira, outros fatores vinculados à estrutura patrimonial e financeira.
          </p>
          <p>Por isso, desenvolvemos duas modalidades de análise.</p>
        </div>
        <div className="flex flex-col gap-8 lg:flex-row lg:gap-7">
          <article className="min-w-0 rounded-3xl border border-[var(--landing-border)] bg-[var(--landing-white)] p-6 lg:flex-1 lg:p-9">
            <h3 className="mb-4 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--landing-muted)]">Dossiê Pessoa Física</h3>
            {pfPrice !== undefined && (
              <div className="mb-6">
                <p className="text-[15px] text-[var(--landing-muted)]">Investimento</p>
                <p className={PRICE_CLASS}>{formatCurrency(pfPrice)}</p>
              </div>
            )}
            <p className="mb-6 text-base leading-[1.6] text-[var(--landing-muted)]">
              Conheça os fatores que podem influenciar sua capacidade de obter crédito e receba um direcionamento estratégico para melhorar seu posicionamento financeiro.
            </p>
            <Includes items={PF_INCLUDES} checkClass="text-[var(--landing-green)]" />
            <Link href={href} className={`${BTN_BASE} w-full border-2 border-[var(--landing-green)] px-4 py-3 text-[var(--landing-green)] hover:bg-[var(--landing-mint)]`}>
              Quero o Dossiê PF
            </Link>
          </article>
          <article className="relative min-w-0 rounded-3xl bg-[var(--landing-green)] p-6 text-white lg:flex-1 lg:p-9">
            <span className="absolute -top-3.5 right-8 rounded-full bg-[var(--landing-yellow)] px-4 py-2 text-xs font-bold tracking-[0.08em] text-[var(--landing-green)]">
              CNPJ + SÓCIOS
            </span>
            <h3 className="mb-4 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--landing-yellow)]">Dossiê Empresarial</h3>
            {companyPrice !== undefined && (
              <div className="mb-6">
                <p className="text-[15px] text-[var(--landing-soft)]">Investimento</p>
                <p className={PRICE_CLASS}>{formatCurrency(companyPrice)}</p>
                <p className="text-[15px] text-[var(--landing-soft)]">
                  por empresa
                  {partnerPrice !== undefined && partnerPrice > 0 && <>, acrescido de {formatCurrency(partnerPrice)} por sócio ou cônjuge incluído na análise.</>}
                </p>
              </div>
            )}
            <div className="mb-6 space-y-3 text-base leading-[1.6] text-[var(--landing-soft)]">
              <p>Sua empresa não deve ser analisada de forma isolada. É importante compreender também os fatores relacionados às pessoas que integram sua estrutura empresarial.</p>
              <p>O Dossiê Empresarial oferece uma visão integrada da situação financeira da empresa e das pessoas envolvidas na análise.</p>
            </div>
            <Includes items={COMPANY_INCLUDES} checkClass="text-[var(--landing-yellow)]" />
            <Link
              href={href}
              className={`${BTN_BASE} w-full bg-[var(--landing-yellow)] px-4 py-3 text-[var(--landing-green)] hover:bg-[var(--landing-yellow-hover)]`}
            >
              Quero o Dossiê Empresarial
            </Link>
          </article>
        </div>
        <p className="mt-6 text-[15px] leading-[1.6] text-[var(--landing-muted)]">
          <strong className="text-[var(--landing-green)]">IMPORTANTE:</strong> Cada pessoa incluída na análise deverá autorizar individualmente a consulta aos seus dados.
        </p>
      </div>
    </section>
  );
}
