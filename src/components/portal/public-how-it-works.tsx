import { ChevronDown } from "lucide-react";

const STEPS = [
  { title: "Crie sua conta", text: "Confirme e-mail e celular (código no WhatsApp)." },
  { title: "Adicione saldo por PIX", text: "Você só paga pelo que usar." },
  { title: "Peça o seu dossiê", text: "Escolha o CPF ou o CNPJ e informe os sócios e cônjuges." },
  {
    title: "Autorize a consulta",
    text: "Você, e cada sócio ou cônjuge, recebe um link para ler o termo e autorizar a consulta ao Banco Central. A análise só começa depois da autorização.",
  },
  {
    title: "Receba o seu plano",
    text: "O raio-x do seu crédito, os pontos cegos que estão te travando e o parecer da Rainha Cred com o caminho em ordem: o que resolver primeiro e o que fazer depois.",
  },
];

const FAQ = [
  { q: "O dossiê garante que vou conseguir crédito?", a: "Não. Quem decide é o banco. O dossiê mostra o que pesa contra você e o caminho para você chegar ao banco do jeito que ele quer ver." },
  { q: "Por que pagar para descobrir o que está errado?", a: "Porque cada pedido negado fica registrado e pesa no próximo. Saber antes é mais barato do que tentar no escuro e tomar mais um \"não\"." },
  { q: "Por que os sócios e os cônjuges entram na análise da empresa?", a: "Porque o banco olha as pessoas por trás do CNPJ. Sócios casados com comunhão total ou parcial de bens levam o cônjuge junto na decisão. O valor é por pessoa." },
  { q: "Preciso de um dossiê para cada pessoa?", a: "Sim. É como um exame de sangue: um por pessoa e um por empresa. Se o sócio tem várias empresas, analise todas para ter o quadro completo." },
  { q: "Posso consultar outra pessoa?", a: "Só com a autorização dela. No Dossiê Empresarial, cada sócio e cada cônjuge autoriza a própria consulta. Sem autorização, a consulta não roda." },
  { q: "Meus dados ficam seguros?", a: "Seguimos a LGPD: você autoriza a consulta e aceita os termos no cadastro." },
];

// Classes da seção e do h2 da página pública do Bureau (tokens de marca).
export const PUBLIC_SECTION = "px-4 pb-2 pt-7 font-[family-name:system-ui,sans-serif] text-base leading-[1.6] text-foreground sm:px-7";
export const PUBLIC_H2 = "mb-3 font-heading text-[22px] font-bold text-brand-deep";

export function PublicHowItWorks() {
  return (
    <>
      <section className={PUBLIC_SECTION}>
        <h2 className={PUBLIC_H2}>Como funciona</h2>
        <ol className="my-4 space-y-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3 rounded-2xl border border-border bg-white p-4 shadow-[0_2px_10px_rgba(5,38,31,0.06)]">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-deep text-sm font-bold text-brand-gold-light">
                {i + 1}
              </span>
              <p className="min-w-0">
                <b className="text-brand-deep">{step.title}.</b> {step.text}
              </p>
            </li>
          ))}
        </ol>
      </section>
      <section className={PUBLIC_SECTION}>
        <h2 className={PUBLIC_H2}>Dúvidas</h2>
        <div className="my-4 overflow-hidden rounded-2xl border border-border bg-white shadow-[0_2px_10px_rgba(5,38,31,0.06)]">
          {FAQ.map((item) => (
            <details key={item.q} className="group border-t border-border first:border-t-0">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 font-bold text-brand-deep hover:bg-[#f4ead7]/60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-deep [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDown aria-hidden className="size-5 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
              </summary>
              <p className="px-4 pb-4 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
