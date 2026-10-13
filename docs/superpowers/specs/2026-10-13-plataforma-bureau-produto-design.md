# Plataforma Bureau — Desenho de Produto e Roadmap

**Data:** 2026-10-13
**Status:** aprovado (brainstorming)
**Escopo:** visão de produto, decisões de negócio, modelo de domínio e roadmap M0–M7. Cada milestone recebe spec própria antes de virar código; este documento é a fonte das issues do GitHub Project "Plataforma Bureau".

## Contexto

O sistema nasceu como ferramenta interna do Reino do Crédito (Next.js + Supabase) e foi migrado para Postgres self-hosted com Better Auth. A migração dos dados de produção foi cancelada: o servidor e os dados foram perdidos. Não haverá uso em produção até todos os milestones terminarem; portanto **não há compatibilidade de dados a preservar** e o schema pode ser redesenhado do zero.

## Visão

SaaS multi-tenant em que **Bureaus** (Reino do Crédito, associação comercial, qualquer empresa) vendem diagnósticos de crédito para pessoas físicas (PF) e jurídicas (PJ). A plataforma detém o contrato com o fornecedor de dados (DEPS) e revende para os Bureaus.

## Atores e papéis

| Papel | Escopo | Pode |
|---|---|---|
| Superadmin | plataforma | criar Bureaus e convidar o admin de cada um; manter catálogo base e custo por Bureau; ver métricas agregadas e financeiro; "entrar como" um Bureau para suporte, com motivo registrado em auditoria. Não vê dados pessoais fora desse modo. |
| Admin do Bureau | um Bureau | gerir equipe, escolher produtos vendidos e preço de venda, comprar saldo pré-pago, ver extrato e repasses. |
| Operador | um Bureau | cadastrar clientes, registrar pagamento de balcão, enviar autorização SCR, executar consultas, liberar resultados ao cliente. |
| Cliente PF/PJ | uma conta em um Bureau | comprar créditos, comprar pesquisas (próprias ou de terceiros com autorização), ver entregas liberadas. Um login por conta (PJ multiusuário fica fora do MVP). |

Sem white-label: toda a interface, e-mails e PDFs usam a marca da plataforma.

## Identificação do tenant

Domínio único. Páginas públicas por Bureau em `/b/<slug>` (vitrine e cadastro). Login único em `/login`; o Bureau de cada usuário vem da conta. Subdomínio/domínio próprio podem vir depois sem quebrar este modelo.

## Dinheiro

- Unidade: **saldo em reais** (1 crédito = R$ 1). Créditos **não expiram**.
- Gateway: **Asaas** (PIX e cartão), com webhooks; **NFS-e emitida pelo Asaas**.
- **Venda online**: o cliente paga a plataforma. Ao consumir um produto, a plataforma retém o custo do Bureau; a diferença (preço de venda − custo) vira **valor a repassar** ao Bureau. Repasse **manual**: o sistema gera o extrato, o superadmin paga fora do sistema e marca como pago.
- **Venda de balcão**: o cliente paga o Bureau diretamente. O custo da consulta é debitado do **saldo pré-pago do Bureau** na plataforma, que o Bureau compra via Asaas.
- **Reserva / captura / estorno**: o valor é reservado ao pedir, capturado quando a consulta DEPS retorna sucesso e liberado automaticamente em caso de falha.
- Todo movimento é registrado em livro-razão imutável (lançamentos), nunca como saldo editável.

## Catálogo

O superadmin cadastra produtos base (Consulta PF, Consulta PJ, Dossiê PJ completo, adicional Parecer IA), mapeados aos produtos DEPS, com custo que pode variar por Bureau. O Bureau escolhe quais vende e define o preço de venda. Parecer IA é vendido como adicional com preço próprio.

## Fluxos de pesquisa

- **Autoatendimento**: cliente escolhe produto → informa o titular (si mesmo ou terceiro) → reserva saldo → titular recebe pedido de autorização SCR (e-mail/WhatsApp) → consulta → entrega.
- **Terceiros**: sempre com autorização SCR do próprio titular antes da consulta.
- **Assistido (balcão)**: operador cadastra o cliente → registra pagamento recebido → envia autorização (e-mail/WhatsApp) → executa → **libera** o resultado para o cliente.
- **Entrega**: relatório na tela, PDF, parecer IA (se comprado) e aviso por e-mail e WhatsApp.

## Cadastro do cliente

Em `/b/<slug>`: confirmação de e-mail, validação de dígito de CPF/CNPJ, aceite de termos de uso e política de privacidade (LGPD) e confirmação do telefone por código via WhatsApp.

## Notificações

E-mail (SMTP) e **WhatsApp Cloud API oficial da Meta** (templates aprovados).

## Modelo de domínio

| Conceito | Definição | Substitui |
|---|---|---|
| Bureau | tenant | — |
| Conta do cliente | quem compra: login, carteira, PF ou PJ | parte de `crm_clients` + `profiles` |
| Titular | quem é pesquisado (CPF/CNPJ), único por Bureau | parte de `crm_clients` |
| Sociedade | vínculo PJ ↔ PF (sócio, %, cargo), criado automaticamente a partir do quadro societário retornado ou informado pelo operador | `crm_client_relations` |
| Dossiê | pedido de um produto: um titular, ou empresa + sócios. Agrupa consultas, parecer IA, PDF, cobrança e liberação | `batches` + `company_reports` |
| Consulta | uma chamada DEPS para um titular, sempre dentro de um Dossiê | `consultations` |
| Autorização SCR | consentimento do titular, reutilizável enquanto válida | `scr_authorizations` |
| Lançamento | movimento imutável de carteira (reserva, captura, estorno, compra, repasse) | — |

Telas: o titular PF mostra empresas em que é sócio, suas consultas e dossiês; o titular PJ mostra sócios (com link) e dossiês com parecer consolidado; a listagem "Pesquisas" lista Dossiês com filtro PF / PJ / PJ completo, nunca perdendo o conjunto.

Motivação: no sistema atual o lote PJ cria cadastros e consultas para empresa e sócios, mas não grava a relação de sociedade nem mostra o lote nas telas de cliente, e `crm_clients` acumula três papéis (comprador, pesquisado, lead).

## Escopo do produto

Permanece: consulta PF/PJ, autorização SCR, parecer IA, dossiê PJ (antigo lote), PDF, auditoria e timeline do titular.
Sai: CRM de oportunidades, financiamento imobiliário, comissão.

## Roadmap

| # | Milestone | Conteúdo | Depende de |
|---|---|---|---|
| M0 | Fundação | bloqueadores do review, dev local, superadmin via secret, script Python de setup, remoção Supabase e módulos cortados, CI com integração | — |
| M1 | Multi-tenant e domínio | `bureaus`, papéis, `bureau_id` + RLS por tenant, novo modelo de domínio (Titular, Sociedade, Dossiê, Consulta), painel superadmin, suporte auditado, `/b/<slug>` | M0 |
| M2 | Catálogo e preços | produtos base, custo por Bureau, preço de venda | M1 |
| M3 | Financeiro | carteiras e livro-razão, Asaas (saldo do Bureau e créditos do cliente, webhooks, NFS-e), extrato de repasse | M2 |
| M4 | Notificações | templates de e-mail, WhatsApp Cloud API | M1 |
| M5 | Contas de cliente | auto-cadastro com verificações, portal | M3, M4 |
| M6 | Pesquisa e entrega | autoatendimento, terceiros com autorização, fluxo assistido com liberação, entrega | M5 |
| M7 | Produção | backup fora do servidor, monitoramento, retenção LGPD, Playwright e2e, DSN de superusuário fora do app em runtime | paralelo |

## Política de migrations

Até o primeiro deploy de produção, `db/migrations/` é uma **base editável**: correções vão direto no arquivo e bancos de dev são recriados (`npm run db:reset`). Após o lançamento, migrations voltam a ser forward-only com checksum.

## Riscos conhecidos

- Backup (Restic) fica no mesmo servidor até o M7 — a perda do servidor leva os backups junto.
- A plataforma recebe o dinheiro das vendas online e repassa manualmente: implica obrigações fiscais e de conciliação do superadmin.
- Consulta de terceiros exige trilha de autorização SCR auditável por titular.
- O repositório é público hoje; será tornado privado.
