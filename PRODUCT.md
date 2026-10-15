# Plataforma Bureau

## Problema e objetivo

O sistema nasceu como ferramenta interna do Reino do Crédito. Agora ele vira uma plataforma multi-tenant. Bureaus vendem diagnósticos de crédito a pessoas físicas (PF) e jurídicas (PJ). A plataforma detém o contrato com o fornecedor de dados (DEPS) e revende a consulta aos Bureaus.

Fonte: [spec de produto](docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md). O roadmap tem os milestones M0 a M7.

## Público e papéis

| Papel | Escopo | Pode |
|---|---|---|
| Superadmin | plataforma | Criar Bureaus e convidar o admin. Manter o catálogo base e o custo por Bureau. Ver métricas e financeiro. "Entrar como" um Bureau para suporte, com motivo em auditoria. |
| Admin do Bureau | um Bureau | Gerir a equipe. Escolher produtos e preço de venda. Comprar saldo pré-pago. Ver extrato e repasses. |
| Operador | um Bureau | Cadastrar clientes. Registrar pagamento de balcão. Enviar autorização SCR. Executar consultas. Liberar resultados. |
| Cliente PF/PJ | uma conta em um Bureau | Comprar créditos e pesquisas. Ver entregas liberadas. Um login por conta. |

- O superadmin não vê dados pessoais fora do modo de suporte.
- Não há white-label: interface, e-mails e PDFs usam a marca da plataforma.
- Um domínio único atende todos. Cada Bureau tem uma página pública em `/b/<slug>`. O login único fica em `/login`.

## Fluxos da versão inicial

- **Autoatendimento:** o cliente escolhe o produto, informa o titular, reserva saldo, o titular autoriza o SCR, a consulta roda e o resultado é entregue.
- **Terceiros:** o titular sempre autoriza o SCR antes da consulta.
- **Assistido (balcão):** o operador cadastra o cliente, registra o pagamento, envia a autorização, executa a consulta e libera o resultado.
- **Entrega:** relatório na tela, PDF, parecer IA (se comprado) e aviso por e-mail e WhatsApp.
- **Cadastro do cliente** em `/b/<slug>`: confirmação de e-mail, validação de CPF/CNPJ, aceite de termos (LGPD) e confirmação do telefone por código no WhatsApp.

## MVP

Roadmap do spec. O estado reflete o repositório em 2026-10-15. A produção não está no ar.

| # | Milestone | Conteúdo |
|---|---|---|
| M0 | Fundação | Dev local, superadmin por secret, script Python de setup, CI com integração. |
| M1 | Multi-tenant e domínio | Bureaus, papéis, RLS por tenant, Titular, Sociedade, Dossiê, Consulta, suporte auditado, `/b/<slug>`. |
| M2 | Catálogo e preços | Produtos base, custo por Bureau, preço de venda. |
| M3 | Financeiro | Carteiras e livro-razão, Asaas, webhooks, NFS-e, repasse. |
| M4 | Notificações | Fila de envio, templates de e-mail, WhatsApp Cloud API. Em desenvolvimento na branch `feature/m4-notificacoes`. |
| M5 | Contas de cliente | Auto-cadastro com verificações, portal. |
| M6 | Pesquisa e entrega | Autoatendimento, terceiros, fluxo assistido, entrega. |
| M7 | Produção | Backup fora do servidor, monitoramento, retenção LGPD, e2e Playwright. |

Cada milestone tem spec e plano em `docs/superpowers/`. Não descreva um milestone como entregue sem checar o código e a spec dele.

## Fora de escopo

- CRM de oportunidades, financiamento imobiliário e comissão.
- White-label.
- Cliente PJ com vários usuários.
- Repasse automático: o superadmin paga fora do sistema e marca como pago.
- Template de WhatsApp de marketing: o M4 envia só mensagens transacionais.
- Subdomínio ou domínio próprio por Bureau (pode vir depois).

## Requisitos

- **Moeda:** 1 crédito = R$ 1. Créditos não expiram.
- **Gateway:** Asaas (PIX e cartão), com webhooks. A NFS-e é emitida pelo Asaas.
- **Venda online:** o cliente paga a plataforma. Ao consumir um produto, a plataforma retém o custo do Bureau. A diferença (preço de venda menos custo) vira valor a repassar. O repasse é manual.
- **Venda de balcão:** o cliente paga o Bureau. O custo da consulta sai do saldo pré-pago do Bureau, comprado via Asaas.
- **Reserva, captura e estorno:** o valor é reservado ao pedir. É capturado quando a consulta DEPS retorna sucesso. É liberado se a consulta falha.
- **Livro-razão:** todo movimento é um lançamento imutável. O saldo nunca é editável.
- **Catálogo:** o superadmin cadastra produtos base (Consulta PF, Consulta PJ, Dossiê PJ completo, adicional Parecer IA), mapeados aos produtos DEPS. O Bureau escolhe o que vende e o preço.
- **Parecer IA:** gerado pela OpenAI e vendido como adicional com preço próprio.
- **SCR:** consulta de terceiros exige autorização do próprio titular, com trilha auditável.
- **Auditoria:** eventos append-only, na mesma transação da mutação. Nunca grave CPF/CNPJ completo.
- **Segurança:** isolamento por Bureau com RLS no Postgres. Autorização é checada no servidor.
- **Idioma:** interface em pt-BR.
- **Notificações:** e-mail (SMTP) e WhatsApp Cloud API oficial da Meta, com templates aprovados.

## Restrições e decisões técnicas

- Stack existente: Next.js 14 (App Router), TypeScript, PostgreSQL 18 com RLS, Better Auth, `pg` sem ORM, npm. Detalhes em [docs/architecture.md](docs/architecture.md).
- Persistência usa SQL puro e migrations numeradas. O projeto não usa Drizzle.
- Nunca reintroduza Supabase.
- Deploy em Docker Swarm, com imagens do GHCR.
- Até o primeiro deploy de produção, `db/migrations/` é uma base editável. Depois, só migrations novas (forward-only, com checksum).

## Hipóteses e pendências

- (hipótese) O repositório será tornado privado. O spec registra isso como risco conhecido.
- Risco: o backup (Restic) fica no mesmo servidor até o M7.
- Risco: a plataforma recebe o dinheiro das vendas online e repassa à mão. Isso implica obrigações fiscais e de conciliação do superadmin.
- Pendência: as specs do M5 e do M6 ainda não existem no repositório.

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

Fechar o M4 (notificações) e abrir o PR da branch `feature/m4-notificacoes`. Depois, escrever a spec do M5 (contas de cliente).

## Manutenção

Atualize este documento quando objetivo, escopo, restrições ou critérios de aceitação mudarem. Decisões técnicas e evidências detalhadas ficam em docs/architecture.md e docs/setup.md. O nome do arquivo gerado é PRODUCT.md.
