import Link from "next/link";

import { BTN_DARK, H2, SECTION_X } from "./landing-styles";

export function LandingFinalCta({ href }: { href: string }) {
  return (
    <section className={`${SECTION_X} bg-[var(--landing-yellow)] py-[72px] text-center text-[var(--landing-green)]`}>
      <div className="mx-auto max-w-[760px] space-y-3 text-lg">
        <h2 className={`${H2} mb-4`}>Não tome decisões de crédito sem conhecer sua realidade financeira.</h2>
        <p>O acesso ao crédito começa muito antes de uma solicitação ao banco.</p>
        <p className="font-bold">Começa com informação, diagnóstico e estratégia.</p>
        <p>
          Conheça os fatores que podem estar comprometendo seu perfil financeiro e tenha um direcionamento para construir uma jornada de crédito mais consciente e planejada.
        </p>
        <p>Rainha do Crédito. Conhecimento, inteligência e estratégia para transformar sua relação com o crédito.</p>
        <p className="pb-4">Acesse a plataforma Rainha Cred e solicite seu dossiê.</p>
        <Link href={href} className={`${BTN_DARK} px-6 py-[18px] lg:px-9`}>
          QUERO SOLICITAR MEU DOSSIÊ
        </Link>
      </div>
    </section>
  );
}

export function LandingFooter() {
  const link = "inline-flex min-h-11 items-center underline underline-offset-4 hover:text-white";
  return (
    <footer className={`${SECTION_X} flex flex-wrap items-center justify-between gap-x-6 gap-y-1 bg-[var(--landing-green)] py-4 text-sm text-[var(--landing-soft)]`}>
      <p className="min-w-0 break-words">Rainha Cred</p>
      <nav aria-label="Documentos legais" className="flex gap-6">
        <Link href="/termos" className={link}>
          Termos
        </Link>
        <Link href="/privacidade" className={link}>
          Privacidade
        </Link>
      </nav>
    </footer>
  );
}
