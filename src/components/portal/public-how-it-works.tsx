import { ChevronDown } from "lucide-react";

const STEPS = [
  {
    title: "Crie sua conta",
    text: ["Realize seu cadastro na plataforma Rainha Cred e confirme seu e-mail e número de celular por meio do código enviado pelo WhatsApp."],
  },
  {
    title: "Adicione saldo à sua conta",
    text: ["Faça a recarga por PIX. Você utiliza o saldo conforme os serviços que solicitar."],
  },
  {
    title: "Solicite seu dossiê",
    text: ["Escolha a modalidade desejada: Pessoa Física ou Empresarial. Informe os dados necessários para realizar a análise."],
  },
  {
    title: "Autorize a consulta",
    text: [
      "Você receberá um link para consultar e aceitar os termos de autorização. No caso de análises empresariais, cada sócio ou cônjuge incluído deverá realizar sua própria autorização.",
      "A análise somente será iniciada após a conclusão das autorizações necessárias.",
    ],
  },
  {
    title: "Receba seu diagnóstico e direcionamento",
    text: [
      "Após a conclusão do processamento, você terá acesso ao relatório na plataforma Rainha Cred e em PDF, com as informações analisadas, os principais pontos de atenção e o parecer estratégico da Rainha do Crédito.",
      "Tudo organizado para que você compreenda sua situação e saiba quais aspectos merecem prioridade.",
    ],
  },
];

const FAQ = [
  {
    q: "O dossiê garante a aprovação de crédito?",
    a: [
      "Não. A aprovação de crédito é uma decisão exclusiva da instituição financeira, de acordo com suas políticas internas e critérios de avaliação.",
      "O objetivo do dossiê é oferecer informações e direcionamentos estratégicos para que você compreenda melhor seu perfil financeiro e possa tomar decisões mais conscientes antes de solicitar crédito.",
    ],
  },
  {
    q: "Por que investir em um dossiê para identificar o que está prejudicando meu crédito?",
    a: [
      "Porque decisões financeiras tomadas sem informação podem gerar novas dificuldades.",
      "Conhecer antecipadamente os fatores que merecem atenção permite organizar prioridades, corrigir possíveis inconsistências e planejar melhor suas próximas solicitações.",
    ],
  },
  {
    q: "Por que os sócios e cônjuges podem precisar participar da análise empresarial?",
    a: [
      "Porque a avaliação de crédito de uma empresa pode considerar informações dos seus sócios e, dependendo da operação, aspectos relacionados à estrutura patrimonial e familiar.",
      "A inclusão de cada pessoa deverá respeitar as condições aplicáveis e exigir sua autorização individual.",
    ],
  },
  {
    q: "Preciso contratar um dossiê para cada pessoa?",
    a: [
      "Sim. A análise é individualizada. Cada CPF incluído corresponde a um dossiê próprio, assim como cada CNPJ possui sua análise empresarial.",
      "Quando um sócio participa de mais de uma empresa, a análise de cada CNPJ permite ampliar a compreensão do cenário empresarial.",
    ],
  },
  {
    q: "Posso solicitar a análise de outra pessoa?",
    a: [
      "Sim, desde que exista autorização expressa da própria pessoa para a consulta dos seus dados.",
      "Nenhuma consulta individual será realizada sem a autorização correspondente.",
    ],
  },
  {
    q: "Meus dados estão protegidos?",
    a: [
      "O tratamento das informações deve observar a Lei Geral de Proteção de Dados Pessoais (LGPD), respeitando as finalidades informadas, as autorizações necessárias e as medidas de segurança aplicáveis.",
    ],
  },
];

// Landing: seções de largura total alternando dois verdes; conteúdo limitado a 704 px (tokens .landing em globals.css).
const SECTION_BASE =
  "px-4 pb-6 pt-7 font-[family-name:system-ui,sans-serif] text-base leading-[1.6] text-white sm:px-[max(1.75rem,calc((100%-704px)/2))]";
export const SECTION_DEEP = `${SECTION_BASE} bg-[var(--landing-green)]`;
export const SECTION_ALT = `${SECTION_BASE} bg-[var(--landing-green-alt)]`;
export const PUBLIC_H2 = "mb-3 font-heading text-[22px] font-bold uppercase text-[var(--landing-yellow)]";
export const YELLOW = "text-[var(--landing-yellow)]";

export function PublicHowItWorks() {
  return (
    <>
      <section className={SECTION_DEEP}>
        <h2 className={PUBLIC_H2}>Como funciona?</h2>
        <p className="mb-3">O processo foi desenvolvido para ser simples, digital e seguro.</p>
        <ol className="my-4 space-y-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3 rounded-2xl border border-[var(--landing-yellow)] bg-[var(--landing-green-alt)] p-4">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--landing-yellow)] text-sm font-bold text-[var(--landing-green)]">
                {i + 1}
              </span>
              <div className="min-w-0 space-y-2">
                <h3 className={`font-bold ${YELLOW}`}>{step.title}</h3>
                {step.text.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className={SECTION_ALT}>
        <h2 className={PUBLIC_H2}>Perguntas frequentes</h2>
        <div className="my-4 overflow-hidden rounded-2xl border border-[var(--landing-yellow)] bg-[var(--landing-green)]">
          {FAQ.map((item) => (
            <details key={item.q} className="group border-t border-[var(--landing-yellow)] first:border-t-0">
              <summary className={`flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 font-bold ${YELLOW} hover:bg-[var(--landing-green-alt)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden`}>
                {item.q}
                <ChevronDown aria-hidden className="size-5 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
              </summary>
              <div className="space-y-2 px-4 pb-4 text-white">
                {item.a.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
