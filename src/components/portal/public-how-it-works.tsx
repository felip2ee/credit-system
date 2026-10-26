const STEPS = [
  { title: "Crie sua conta", text: "Confirme e-mail e celular (código no WhatsApp)." },
  { title: "Adicione saldo por PIX", text: "Você só paga pelo que usar." },
  { title: "Faça a pesquisa", text: "Escolha o seu CPF ou o CNPJ de uma empresa sua e autorize a consulta." },
  { title: "Receba o resultado", text: "Na tela e em PDF, com aviso por e-mail e WhatsApp." },
];

const FAQ = [
  { q: "O dossiê garante que vou conseguir crédito?", a: "Não. Ele mostra o que pesa contra você hoje e o que vem atrapalhando. A decisão de conceder crédito é sempre do banco." },
  { q: "Por que os sócios entram na análise da empresa?", a: "Ao analisar o crédito de uma empresa, o banco também olha a situação dos sócios. Por isso o Dossiê Empresarial inclui cada sócio, e o valor é por sócio." },
  { q: "Qual dossiê eu escolho?", a: "O Dossiê Pessoa Física analisa o seu CPF. O Dossiê Empresarial analisa o CNPJ da sua empresa e os sócios dela." },
  { q: "O que eu recebo no final?", a: "Um relatório na tela e em PDF, com o parecer pela metodologia da Rainha Cred e orientações. Você é avisado por e-mail e WhatsApp quando ele fica pronto." },
  { q: "Posso consultar outra pessoa?", a: "Não. Você consulta só o seu CPF e os CNPJs das suas empresas. A consulta só roda depois da sua autorização." },
  { q: "Meus dados ficam seguros?", a: "Seguimos a LGPD: você autoriza a consulta e aceita os termos no cadastro." },
];

export function PublicHowItWorks() {
  return (
    <>
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Como funciona</h2>
        <ol className="space-y-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-bold">{step.title}</p>
                <p className="text-sm text-muted-foreground">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="space-y-1">
        <h2 className="text-lg font-bold">Dúvidas</h2>
        {FAQ.map((item) => (
          <details key={item.q} className="border-t py-2">
            <summary className="cursor-pointer font-bold">{item.q}</summary>
            <p className="mt-1 text-sm text-muted-foreground">{item.a}</p>
          </details>
        ))}
      </section>
    </>
  );
}
