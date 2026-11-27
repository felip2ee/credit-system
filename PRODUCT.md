# Plataforma Bureau

## Problema e objetivo

O sistema nasceu como ferramenta interna do Rainha Cred. Agora ele vira uma plataforma multi-tenant. Bureaus vendem diagnósticos de crédito a pessoas físicas (PF) e jurídicas (PJ). A plataforma detém o contrato com o fornecedor de dados (DEPS) e revende a consulta aos Bureaus.

Fonte: [spec de produto](docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md). O roadmap tem os milestones M0 a M7.

## Público e papéis

| Papel | Escopo | Pode |
|---|---|---|
| Superadmin | plataforma | Criar Bureaus e convidar o admin. Definir produtos, preço de venda, % do Bureau, % de afiliados, sócios e `walletId` do split, e bloqueio de produto por Bureau. Ver métricas e financeiro. "Entrar como" um Bureau para suporte, com motivo em auditoria. |
| Admin do Bureau | um Bureau | Gerir a equipe. Ver o catálogo, a própria % e os afiliados (somente leitura). Ligar ou desligar o afiliado de link. Comprar saldo pré-pago. Ver extrato e repasses. |
| Operador | um Bureau | Cadastrar clientes. Registrar pagamento de balcão. Enviar autorização SCR. Executar consultas. Liberar resultados. |
| Cliente PF/PJ | uma conta em um Bureau | Comprar créditos e pesquisas. Ver entregas liberadas. Um login por conta. |

- O superadmin não vê dados pessoais fora do modo de suporte.
- Não há white-label: interface, e-mails e PDFs usam a marca da plataforma.
- Um domínio único atende todos. Cada Bureau tem uma página pública em `/b/<slug>`. O login único fica em `/login`.

## Fluxos da versão inicial

- **Autoatendimento:** o cliente escolhe o produto, informa o titular, reserva saldo, o titular autoriza o SCR, a consulta roda e o resultado é entregue.
- **Terceiros:** o titular sempre autoriza o SCR antes da consulta.
- **Assistido (balcão):** o operador cadastra o cliente, registra o pagamento, envia a autorização, executa a consulta e libera o resultado.
- **Entrega:** relatório na tela, PDF, parecer IA (incluso em todo pedido) e aviso por e-mail, WhatsApp e push no aparelho (portal do cliente, opcional).
- **Link de pagamento (balcão):** o operador abre a consulta, gera um link `/pagar/<token>` (válido 7 dias) e envia ao cliente. O cliente paga o Pix na página e a baixa é automática.
- **Cadastro do cliente** em `/b/<slug>`: validação de CPF/CNPJ, aceite de termos (LGPD) e confirmação do telefone por código no WhatsApp.

## MVP

Roadmap do spec. O estado reflete o repositório em 2026-10-15. A produção não está no ar.

| # | Milestone | Conteúdo |
|---|---|---|
| M0 | Fundação | Dev local, superadmin por secret, script Python de setup, CI com integração. |
| M1 | Multi-tenant e domínio | Bureaus, papéis, RLS por tenant, Titular, Sociedade, Dossiê, Consulta, suporte auditado, `/b/<slug>`. |
| M2 | Catálogo e preços | Produtos base, custo por Bureau, preço de venda. |
| M3 | Financeiro | Carteiras e livro-razão, Asaas, webhooks, NFS-e, repasse. |
| M4 | Notificações | Fila de envio, templates de e-mail, WhatsApp Cloud API. Em desenvolvimento na branch `feature/m4-notificacoes`. |
| M5 | Contas de cliente | Auto-cadastro com verificações, portal. Em execução na branch `feature/m5-contas-de-cliente`. Spec: [docs/superpowers/specs/2026-10-15-m5-contas-de-cliente-design.md](docs/superpowers/specs/2026-10-15-m5-contas-de-cliente-design.md). |
| M6 | Pesquisa e entrega | Autoatendimento, terceiros, fluxo assistido, entrega. Em execução na branch `feature/m6-pesquisa-e-entrega`. Spec: [docs/superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md](docs/superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md). |
| M7 | Produção | Backup fora do servidor, monitoramento, retenção LGPD, e2e Playwright. Em execução na branch `feature/m7-producao`. Spec: [docs/superpowers/specs/2026-10-16-m7-producao-design.md](docs/superpowers/specs/2026-10-16-m7-producao-design.md). |

Cada milestone tem spec e plano em `docs/superpowers/`. Não descreva um milestone como entregue sem checar o código e a spec dele.

## Fora de escopo

- CRM de oportunidades e financiamento imobiliário.
- White-label.
- Cliente PJ com vários usuários.
- Repasse automático: o superadmin paga fora do sistema e marca como pago.
- Template de WhatsApp de marketing: o M4 envia só mensagens transacionais.
- Subdomínio ou domínio próprio por Bureau (pode vir depois).
- Cupom no balcão (a equipe abre a pesquisa). Só o portal do cliente usa cupom.
- Desconto na recarga de saldo.
- Mais de um cupom por pesquisa.
- Cupom criado pela plataforma ou pelo afiliado.
- Cupom que o cliente recebe sem digitar o código.

## Requisitos

- **Moeda:** 1 crédito = R$ 1. Créditos não expiram.
- **Gateway:** Asaas (PIX e cartão em até 12x), com webhooks. A NFS-e é emitida pelo Asaas.
- **Taxas do Asaas:** o pagador paga as taxas. O cartão repassa percentual e taxa fixa (`CARD_FEE_TABLE`). O Pix repassa a taxa fixa por cobrança (`PIX_FEE_CENTS`, hoje R$ 1,99). O saldo sobe só pela recarga. O limite de R$ 10,00 a R$ 5.000,00 vale para a recarga. Runbook: [docs/operations/payments.md](docs/operations/payments.md).
- **Pagador:** o checkout pergunta quem paga: o dono da conta ou outra pessoa ou empresa. Cada cobrança leva o cliente Asaas de quem paga. Os dados de pagamento do dono ficam cifrados. Runbook: [docs/operations/payments.md](docs/operations/payments.md). Spec: [docs/superpowers/specs/2026-11-06-pagamento-por-pagador-design.md](docs/superpowers/specs/2026-11-06-pagamento-por-pagador-design.md).
- **Venda online:** o cliente paga a plataforma. A cobrança Asaas leva um split: sócios, o Bureau e a comissão de indicação e de afiliado recebem a parte deles no recebimento. O restante fica com a plataforma. Bureau sem `walletId` recebe a parte por repasse manual.
- **Venda de balcão:** o cliente paga o Bureau. O Bureau repassa à plataforma o preço menos a comissão do Bureau, debitado do saldo pré-pago (comprado via Asaas). A comissão do Bureau fica com ele.
- **Cupons:** o Bureau cria cupons percentuais ou de valor fixo. Cada cupom vale para todos os produtos ou para produtos escolhidos. Limites: usos totais, usos por cliente, início e validade. O cliente digita o código no portal antes de abrir uma pesquisa. O desconto sai da comissão do Bureau: a parte da plataforma não muda. Se o desconto passa da comissão, o Bureau cobre a diferença. Spec: [docs/superpowers/specs/2026-11-19-cupons-desconto-design.md](docs/superpowers/specs/2026-11-19-cupons-desconto-design.md).
- **App do Bureau (`/admin`):** app instalável no mesmo domínio, com os links do Bureau, nova consulta, cobranças e métricas. O Pix do link cai na conta Asaas da plataforma. Não há repasse automático ao Bureau nem NFS-e do Pix de link. Runbook: [docs/operations/payment-links.md](docs/operations/payment-links.md).
- **Visitas:** a vitrine `/b/<slug>` conta visitas por dia, sem IP e sem cookie. Bots entram na contagem.
- **Reserva, captura e estorno:** o valor é reservado ao pedir. É capturado quando a consulta DEPS retorna sucesso. É liberado se a consulta falha.
- **Livro-razão:** todo movimento é um lançamento imutável. O saldo nunca é editável.
- **Catálogo:** só o superadmin define produtos (Dossiê Pessoa Física e Dossiê Empresarial, mapeados aos produtos DEPS), preço de venda, % do Bureau e bloqueio de produto por Bureau. O Bureau não edita nada disso e não tem custo. Produto sem preço, ou bloqueado para o Bureau, não está à venda. A plataforma não vende nada até o superadmin definir esses valores.
- **Comissão do Bureau:** uma % do valor líquido de cada cobrança Asaas que entra por dinheiro (recarga, pedido, link), global. O superadmin pode definir uma % própria para um Bureau (override). Sem % global, nenhuma venda é aceita. Crédito manual e consumo de saldo não geram comissão.
- **Preço:** total = valor base + valor por sócio × sócios distintos (por CPF, de 0 a 20). O valor por sócio só vale no Dossiê Empresarial.
- **Repartição de cada entrada:** o split divide o valor líquido de cada cobrança entre sócios, Bureau, Bureau indicador e afiliado de link. Plataforma = o resto. Os valores são arredondados ao centavo e a plataforma absorve o centavo. Soma acima de 100% não cria a cobrança. Com cupom, as contas usam o preço bruto (de tabela). O desconto sai só da parte do Bureau: a plataforma e o afiliado recebem o mesmo de uma venda sem cupom.
- **Parecer IA:** todo pedido inclui o parecer, gerado pela OpenAI. Não há adicional nem preço próprio. O custo fica no valor base.
- **Portal:** a conta PF compra o Dossiê Pessoa Física só para si. A conta PJ informa CPF, nome e e-mail do responsável. O Dossiê Empresarial vale para qualquer CNPJ, com sócios. Pedido com membros exige a declaração do comprador. A página do pedido mostra o estado do aceite SCR de cada membro. O cliente cancela antes da execução e o valor volta ao saldo.
- **Avisos no aparelho (portal):** em Conta › Notificações (`/portal/notificacoes`) o cliente liga os avisos push neste aparelho e vê como instalar o app. Sair remove o aparelho.
- **Afiliados:** todo cliente tem um link de indicação (`/b/<slug>/cadastro?ref=<código>`). O vínculo nasce só no cadastro. A comissão é uma % do valor líquido da cobrança, uma só para todos os afiliados de cada Bureau, definida pelo superadmin. O afiliado recebe pelo split do Asaas (modo conta Asaas) ou pelo saldo, após a confirmação do pagamento (modo Pix). A comissão sai da parte da plataforma, nunca da do Bureau. O indicado precisa ter o celular verificado. O Bureau liga e desliga o recurso. No modo Pix, a comissão fica em carência (padrão 0 dia) e depois fica disponível. A afiliada converte o saldo em créditos ou pede saque por PIX com taxa. O superadmin paga fora do sistema e anexa o comprovante. O estorno da cobrança reverte a comissão: o Asaas reverte o split, e no modo Pix o saldo pode ficar negativo até as próximas comissões. Runbook: [docs/operations/affiliates.md](docs/operations/affiliates.md). Spec: [docs/superpowers/specs/2026-10-24-programa-de-afiliados-design.md](docs/superpowers/specs/2026-10-24-programa-de-afiliados-design.md).
- **SCR:** consulta de terceiros exige autorização do próprio titular, com trilha auditável.
- **Auditoria:** eventos append-only, na mesma transação da mutação. CPF/CNPJ completo só fica cifrado no banco (`src/lib/pii/`; colunas de CRM em `holders` são exceção documentada). Nunca grave CPF/CNPJ completo em log, auditoria, erro ou exportação: use a forma mascarada.
- **Segurança:** isolamento por Bureau com RLS no Postgres. Autorização é checada no servidor.
- **Idioma:** interface em pt-BR.
- **Notificações:** e-mail (SMTP) e WhatsApp Cloud API oficial da Meta, com templates aprovados.

## Restrições e decisões técnicas

- Stack existente: Next.js 14 (App Router), TypeScript, PostgreSQL 18 com RLS, Better Auth, `pg` sem ORM, npm. Detalhes em [docs/architecture.md](docs/architecture.md).
- Persistência usa SQL puro e migrations numeradas. O projeto não usa Drizzle.
- Nunca reintroduza Supabase.
- Deploy em Docker Swarm, com imagens do GHCR.
- Até o primeiro deploy de produção, `db/migrations/` é uma base editável. A partir do primeiro deploy de produção (data: preencher no deploy), `db/migrations/` é forward-only com checksum.

## Hipóteses e pendências

- (hipótese) O repositório será tornado privado. O spec registra isso como risco conhecido.
- Risco: a plataforma recebe o dinheiro das vendas online e repassa à mão. Isso implica obrigações fiscais e de conciliação do superadmin.

## Critérios de aceitação

Critérios do produto, por fluxo do MVP:

- O superadmin cria um Bureau e convida o admin.
- O operador envia uma autorização SCR e executa a consulta só depois que o titular autoriza.
- Uma consulta com falha libera a reserva de saldo.
- Um lançamento do livro-razão nunca muda depois de gravado.
- Um usuário de um Bureau não lê dados de outro Bureau.
- O cliente só vê entregas liberadas.

Os checks técnicos ficam em [docs/quality.md](docs/quality.md).

## Próxima entrega

Concluir o M7 (produção) conforme a spec e abrir o PR da branch `feature/m7-producao`. Depois, fechar o M5 e o M4 conforme a tabela do MVP.

## Manutenção

Atualize este documento quando objetivo, escopo, restrições ou critérios de aceitação mudarem. Decisões técnicas e evidências detalhadas ficam em docs/architecture.md e docs/setup.md. O nome do arquivo gerado é PRODUCT.md.
