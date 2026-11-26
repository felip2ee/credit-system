import { H2, CONTAINER, EYEBROW, SECTION_X } from "./landing-styles";

const STEPS = [
  {
    title: "Crie sua conta",
    text: ["Realize seu cadastro na plataforma Rainha Cred e confirme seu número de celular por meio do código enviado pelo WhatsApp."],
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

export function LandingDifferential() {
  return (
    <section className={`${SECTION_X} bg-[var(--landing-green-alt)] py-16 text-white lg:py-24`}>
      <div className="mx-auto max-w-[880px] text-center">
        <p className={`${EYEBROW} mb-4`}>O diferencial</p>
        <h2 className={`${H2} mb-7 lg:text-[44px]`}>Parecer estratégico da Rainha do Crédito</h2>
        <div className="space-y-5 text-[17px] leading-[1.65] text-[var(--landing-soft)] lg:text-[19px]">
          <p>Ao contratar seu dossiê, você não recebe apenas um relatório com informações financeiras.</p>
          <p>
            Você recebe um Parecer Estratégico da Rainha do Crédito, desenvolvido com base em uma metodologia própria e em 16 anos de experiência no mercado de crédito.
          </p>
          <p>
            A análise utiliza recursos de inteligência artificial como ferramenta de apoio para organizar informações, identificar pontos de atenção e estruturar um direcionamento estratégico.
          </p>
          <p>
            O resultado é uma avaliação que apresenta os principais aspectos que merecem atenção no seu perfil financeiro, além de orientações para que você compreenda melhor sua situação e saiba quais caminhos considerar para melhorar seu posicionamento perante o mercado financeiro.
          </p>
          <p>
            A plataforma Rainha Cred proporciona o ambiente digital para que você tenha acesso ao seu dossiê de forma prática e organizada.
          </p>
        </div>
        <p className="lp-serif mt-6 text-2xl italic leading-[1.35] text-[var(--landing-yellow)] lg:text-[26px]">
          A tecnologia organiza as informações. A experiência e o conhecimento da Rainha do Crédito transformam essas informações em estratégia.
        </p>
      </div>
    </section>
  );
}

export function LandingSteps() {
  return (
    <section className={`${SECTION_X} py-16 lg:py-24`}>
      <div className={CONTAINER}>
        <h2 className={`${H2} mb-3`}>Como funciona?</h2>
        <p className="mb-11 text-[17px] text-[var(--landing-muted)]">O processo foi desenvolvido para ser simples, digital e seguro.</p>
        <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5 lg:gap-5">
          {STEPS.map((step, i) => (
            <li key={step.title} className="min-w-0">
              <span
                aria-hidden
                className={`lp-serif mb-4 inline-flex size-11 items-center justify-center rounded-full text-xl font-bold ${
                  i === STEPS.length - 1 ? "bg-[var(--landing-green)] text-[var(--landing-yellow)]" : "bg-[var(--landing-yellow)] text-[var(--landing-green)]"
                }`}
              >
                {i + 1}
              </span>
              <h3 className="mb-2 break-words text-lg font-bold">{step.title}</h3>
              <div className="space-y-2 text-[15px] leading-[1.6] text-[var(--landing-muted)]">
                {step.text.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function LandingFaq() {
  return (
    <section className={`${SECTION_X} pb-16 lg:pb-24`}>
      <div className="mx-auto max-w-[880px]">
        <h2 className={`${H2} mb-7`}>Perguntas frequentes</h2>
        <div className="flex flex-col gap-3">
          {FAQ.map((item) => (
            <details key={item.q} className="group rounded-2xl border border-[var(--landing-border)] bg-[var(--landing-white)] px-5 py-3 lg:px-[26px]">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 break-words">{item.q}</span>
                <span aria-hidden className="shrink-0 text-2xl font-bold leading-none">
                  <span className="group-open:hidden">+</span>
                  <span className="hidden group-open:inline">−</span>
                </span>
              </summary>
              <div className="space-y-2 pb-3 pt-3 text-base leading-[1.65] text-[var(--landing-muted)]">
                {item.a.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
