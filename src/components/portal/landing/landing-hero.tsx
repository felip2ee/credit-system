import Link from "next/link";
import { ChartColumn, Check, TriangleAlert, type LucideIcon } from "lucide-react";

import { BrandLogo } from "@/components/portal/brand-logo";

import { BTN_YELLOW, CONTAINER, EYEBROW, SECTION_X } from "./landing-styles";

const PREVIEW_ROWS: { icon: LucideIcon; label: string; accent: boolean }[] = [
  { icon: Check, label: "Análise do CPF / CNPJ no SCR", accent: false },
  { icon: TriangleAlert, label: "Pontos de atenção", accent: false },
  { icon: ChartColumn, label: "Parecer estratégico", accent: true },
];

export function LandingHeader({ href }: { href: string }) {
  return (
    <header className={`${SECTION_X} bg-[var(--landing-green)] pb-5 pt-5`}>
      <div className={CONTAINER}>
        <div className="flex items-center justify-between gap-3">
          <BrandLogo variant="full" tone="light" className="h-11 lg:h-12" />
          <Link
            href={href}
            className="inline-flex min-h-11 min-w-[104px] items-center justify-center rounded-full bg-[var(--landing-yellow)] px-6 text-base font-bold text-[var(--landing-green)] hover:bg-[var(--landing-yellow-hover)]"
          >
            Entrar
          </Link>
        </div>
      </div>
    </header>
  );
}

function ReportPreview() {
  return (
    <div className="rounded-3xl bg-[var(--landing-white)] p-6 text-[var(--landing-green)] shadow-[0_30px_60px_rgba(0,0,0,0.35)] lg:p-7">
      <div className="mb-[22px] flex items-center justify-between gap-3">
        <p className="lp-serif text-xl font-bold">Seu dossiê</p>
        <span className="rounded-full bg-[var(--landing-green)] px-3 py-1.5 text-xs font-semibold text-[var(--landing-yellow)]">PDF + plataforma</span>
      </div>
      <ul className="flex flex-col gap-[14px]">
        {PREVIEW_ROWS.map(({ icon: Icon, label, accent }) => (
          <li key={label} className="flex items-center gap-[14px]">
            <span
              aria-hidden
              className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] ${accent ? "bg-[var(--landing-yellow)]" : "bg-[var(--landing-mint)]"}`}
            >
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
            <span className="min-w-0 text-[15px] font-semibold">{label}</span>
          </li>
        ))}
      </ul>
      <div aria-hidden className="mt-6 flex flex-col gap-[9px]">
        <div className="h-2.5 w-full rounded-md bg-[var(--landing-mint)]" />
        <div className="h-2.5 w-[92%] rounded-md bg-[var(--landing-mint)]" />
        <div className="h-2.5 w-[64%] rounded-md bg-[var(--landing-mint)]" />
      </div>
    </div>
  );
}

export function LandingHero({ href }: { href: string }) {
  return (
    <section className={`${SECTION_X} bg-[var(--landing-green)] pb-16 pt-10 text-white lg:pb-24`}>
      <div className={`${CONTAINER} flex flex-col gap-10 lg:flex-row lg:items-center lg:gap-14`}>
        <div className="min-w-0 motion-safe:animate-fade-in lg:flex-[1_1_520px]">
          <p className={`${EYEBROW} mb-[18px]`}>Dossiê de crédito · CPF e CNPJ</p>
          <h1 className="lp-serif mb-6 break-words text-[36px] font-bold leading-[1.1] lg:text-[58px] lg:leading-[1.06]">
            Conheça o que está impedindo seu acesso ao crédito.{" "}
            <em className="text-[var(--landing-yellow)]">Descubra o caminho para mudar essa realidade.</em>
          </h1>
          <div className="mb-8 max-w-[560px] space-y-3 text-base leading-[1.6] text-[var(--landing-soft)] lg:text-lg">
            <p>
              Você sabe que existe algo dificultando seu acesso ao crédito, mas talvez ainda não saiba exatamente o que está comprometendo sua análise financeira.
            </p>
            <p>
              O Dossiê da Rainha Cred foi desenvolvido para identificar fatores que podem limitar seu acesso ao crédito, tanto no CPF quanto no CNPJ, e apresentar um direcionamento estratégico para melhorar seu posicionamento perante o sistema financeiro.
            </p>
            <p>
              Mais do que consultar informações, você terá uma análise estruturada da sua situação e um parecer estratégico da Rainha do Crédito, com orientações para compreender o que merece atenção antes de buscar novas oportunidades de crédito.
            </p>
            <p className="font-bold text-[var(--landing-yellow)]">Informação, estratégia e inteligência para tomar decisões mais conscientes.</p>
          </div>
          <Link href={href} className={`${BTN_YELLOW} px-6 py-[18px] lg:px-[34px]`}>
            QUERO CONHECER MEU DOSSIÊ
          </Link>
        </div>
        <div className="min-w-0 motion-safe:animate-slide-in-right lg:max-w-[460px] lg:flex-[1_1_380px]">
          <ReportPreview />
        </div>
      </div>
    </section>
  );
}
