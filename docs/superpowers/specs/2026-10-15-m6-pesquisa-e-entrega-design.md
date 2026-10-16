# M6 — Pesquisa e entrega: Desenho

**Data:** 2026-10-15
**Status:** rascunho. O usuário não estava disponível. O agente tomou todas as decisões (D1–D32). As decisões com risco de negócio estão em "Decisões a confirmar" e precisam de aprovação antes da execução.
**Milestone:** M6 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #42, #43, #44, #45, #46, #65. Fecha também #27 (M3), #34 e #36 (M4). Ver "Ajustes nas issues".
**Depende de:** M2 (`quoteOrder`, `public_bureau_catalog`, `product_versions.deps_product`), M3a/M3b (`reserve_order`, `capture_order`, `release_order`, `counter_payments`), M4 (fila de notificações, templates, worker por cron), M5 (conta do cliente, `profiles.notification_channel`, telefone confirmado).

## Decisões a confirmar

Estas decisões têm risco real de negócio. O plano as aplica como estão. Uma resposta diferente muda as tasks indicadas.

| # | Decisão tomada | Alternativa | Custo se errada | Tasks |
|---|---|---|---|---|
| D2 | Todo Dossiê novo nasce como pedido pago. O fluxo atual da equipe (`/dossiers/new`, `/consultations/new`) vira o pedido de balcão: reserva o custo do Bureau e exige pagamento registrado antes da consulta. | Manter o fluxo interno sem cobrança, ao lado do pedido. | A equipe perde a consulta "de cortesia". Na alternativa, a DEPS é chamada sem reserva. | 1, 3, 5, 6 |
| D6 | Falha terminal da DEPS (sem dados, payload incompatível, 5 tentativas sem resposta) libera a reserva. A plataforma absorve o custo DEPS da chamada. | Capturar mesmo com falha. | Custo DEPS sem receita em cada falha. | 4 |
| D7 | Sem estorno depois da captura. O tipo `reversal` de `bureau_payable_entries` continua reservado. | Estorno automático ao revogar ou na falha do parecer IA. | O cliente pede reembolso e o superadmin faz ajuste manual. | — |
| D8 | O autoatendimento vende só `consulta_pf` e `consulta_pj` (com ou sem `parecer_ia`). `dossie_pj_completo` só no balcão. | PJ completo também no autoatendimento. | Venda online menor do produto mais caro. | 1, 3, 7 |
| D9 | A pesquisa própria também exige autorização SCR por código. O pedido vai para o e-mail confirmado do cliente. Não há KYC. | Consentimento na sessão (caixa de aceite) ou KYC externo. | Quem cadastrou o CPF de outra pessoa (risco do M5) autoriza a pesquisa dela com o próprio e-mail. | 1, 4 |
| D10 | A autorização vale para novos pedidos do mesmo Bureau, do mesmo Titular **e do mesmo comprador**. | Reuso por Bureau e Titular, para qualquer comprador. | Na alternativa, o consentimento dado a um comprador serve a outro (LGPD). Na escolha, o titular recebe mais pedidos. | 1 |
| D11 | Autorização válida por 365 dias (valor atual da 009). Pedido de autorização expira 7 dias depois do envio. | Outros prazos. | Prazo curto: mais cancelamentos. Prazo longo: reserva presa por mais tempo. | 1, 2, 4 |
| D13 | O pedido de autorização ao terceiro vai por e-mail (obrigatório) e por WhatsApp quando o comprador informa o celular. O celular do terceiro não é confirmado. | Só e-mail para terceiro. | Mensagem para número errado ou de outra pessoa. | 2, 4 |
| D18 | Pedido de balcão sem pagamento completo em 7 dias é cancelado e libera o custo reservado do Bureau. | Sem prazo. Cancelamento só manual. | Pedido abandonado ou saldo do Bureau preso. | 3, 4 |
| D20 | O autoatendimento libera o resultado sozinho ao concluir. O balcão libera só por ação do operador. | Liberação manual também no autoatendimento. | Na escolha, o Bureau não revisa antes da entrega online. | 3, 4 |
| D21 | Parecer IA com falha em 3 tentativas: a entrega sai sem parecer, e a equipe gera de novo pela tela. O valor do adicional não volta (D7). | Liberar a parte do adicional na falha. | Cliente paga por parecer que não recebeu até a equipe agir. | 4 |
| D30 | O PDF do cliente usa o timbrado atual (`public/letterhead.png`, marca Rainha do Crédito) como marca da plataforma. | Arte nova da plataforma. | Trocar o PNG depois (sem código). | 5 |

## Objetivo

Ligar o pedido de pesquisa ao dinheiro, ao consentimento e à entrega:
- O cliente compra uma pesquisa no portal: escolhe o produto, o titular (ele mesmo ou um terceiro) e o parecer IA. O preço sai da carteira dele como reserva (#42).
- Nenhuma consulta roda sem autorização SCR do titular. O pedido de autorização sai por e-mail ou WhatsApp. A autorização vale para pedidos futuros enquanto for válida. O pedido expirado cancela o pedido e libera a reserva (#43).
- O operador atende no balcão: cadastra cliente e titular, registra o pagamento, envia a autorização e executa a consulta (#44).
- No balcão, o resultado aparece para o cliente só depois da liberação pelo operador. Liberar e revogar ficam na auditoria. O cliente recebe aviso (#45).
- O cliente vê o relatório na tela, baixa o PDF, recebe o parecer IA quando comprou e recebe aviso por e-mail e WhatsApp (#46).
- O portal lista as pesquisas do cliente com o estado. A RLS deixa o cliente ler só os próprios pedidos e só as entregas liberadas (#65).

## Ponto de partida

- `createDossier` (`src/lib/dossiers/queries.ts`) cria Titular, Dossiê e consultas para a equipe, sem cobrança. `processDossierMember`, `runConsultation`, `reprocessQuery` e `verifyScr` chamam a DEPS direto das Server Actions.
- `reserve_order(order_ref, mode, client_profile_id, price, cost, quote)` (018) exige, no modo online, que o Titular do Dossiê tenha `client_profile_id = app_user_id()`. Uma pesquisa de terceiro falha com `not_found`.
- `capture_order` e `release_order` (019) aceitam a equipe e o cliente dono. `capture_order` com reserva retomada por estorno responde `reservation_clawed_back` (o TS trata como `released`).
- `counter_payments` (015) registra o pagamento de balcão por Dossiê e não muda carteira.
- A RLS de `dossiers`, `consultations`, `bureau_results`, `ai_reports` e `scr_authorizations` só deixa a equipe ler. O cliente lê só o próprio Titular (`holders_client_select`).
- `scr_authorizations` guarda uma linha por documento, atualizada no lugar. `confirm_public_scr_authorization` (009) grava `expires_at = now() + 365 days` e não tem prazo para o pedido pendente. `generateCode` em `scr-self.ts` usa `Math.random`.
- `issueSelfScrAuthorization` grava o código e enfileira só o e-mail `scr_authorization`.
- `enqueue_notification` (020) recusa o papel `client`. O worker do M4 roda por cron (`scripts/notifications-cron.mjs`) com `NOTIFICATIONS_DISPATCH_SECRET`.
- `depsProductName()` e `DEPS_PRODUTO_PF|PJ` dão o nome do produto DEPS. O cliente real ignora `options.product` e usa o nome do ambiente para achar o identificador.
- O parecer IA da consulta (`generateOpinion`, `src/actions/ai.ts`) e o do Dossiê (`generateDossierReport`) só rodam com sessão. `getAiPrompt` e `getScrTermSettings` (`src/actions/settings.ts`) leem com a identidade da sessão.
- O PDF do Dossiê (`/dossiers/<id>/pdf`) usa `renderDossierPdf` e `public/letterhead.png`. O cabeçalho do portal mostra "Rainha do Crédito".
- `/portal` mostra o cartão vazio "Suas pesquisas".

## Decisões

1. **D1 — Pedido em tabela própria.** `dossier_orders` (1:1 com `dossiers`, chave `dossier_id`) guarda modo, comprador, produto, adicional, estado, motivo, tentativas, lease, parecer IA, liberação e revogação. Razão: RLS filtra linha, não coluna. Com a tabela separada, o cliente lê o estado do pedido sem ler o relatório do Dossiê.
2. **D2 — Uma porta de entrada (a confirmar).** Todo Dossiê novo nasce pela função `open_order`, para o cliente (online) e para a equipe (balcão). Saem `createDossier`, `runConsultation`, `processDossierMember`, `reprocessQuery`, `verifyScr` e `retryScrByQuery`. Toda chamada à DEPS passa pela execução do pedido (D16). Razão: nenhuma chamada DEPS sem reserva.
3. **D3 — Máquina de estados.** Ver "Estados do pedido". O trigger `dossier_orders_guard` recusa transição fora da tabela, mudança de coluna imutável e DELETE. Razão: o SQL protege a regra, não só o TypeScript.
4. **D4 — Reserva ao abrir.** A transação de abertura chama `open_order` e depois `reserveOrder` (M3b). Online reserva o preço `P` na carteira do cliente. Balcão reserva o custo `C` na carteira do Bureau. Falha da reserva (`insufficient_balance`) desfaz o pedido inteiro. Razão: #42 e doc de produto ("reservado ao pedir").
5. **D5 — Captura.** A captura (`captureOrder`) roda quando a consulta do Titular principal termina `completed`, na transação que marca o pedido `completed`. Sócio do PJ completo com erro não impede a captura. Captura com reserva retomada (`clawedBack`) marca o pedido `failed` (`reservation_clawed_back`) e não entrega. Razão: o preço é do Dossiê; o Titular principal é o produto.
6. **D6 — Falha da DEPS (a confirmar).** Erro de rede ou do provedor antes da resposta é transitório: o pedido volta para `ready` com espera de `2^(tentativa−1)` minutos (máximo 60), até 5 tentativas. Na 5ª falha, o pedido vai para `failed` (`deps_unavailable`) e a reserva é liberada. `no_data` (ou `DepsScrPendingError`) e `payload_incompatible` no Titular principal: `failed` (`deps_no_data`, `deps_incompatible`) e liberação. Razão: o cliente não paga por resultado que não recebe.
7. **D7 — Sem estorno após captura (a confirmar).** O M6 não devolve valor capturado. `reversal` em `bureau_payable_entries` fica reservado. Razão: nenhuma issue do M6 pede reembolso; o ajuste manual do superadmin cobre o caso raro.
8. **D8 — Produtos por canal (a confirmar).** Autoatendimento: `consulta_pf` (Titular PF) e `consulta_pj` (Titular PJ), com ou sem `parecer_ia`. Balcão: os três produtos. Razão: o PJ completo pede uma autorização por sócio, e o comprador online não conhece os contatos dos sócios.
9. **D9 — Autorização sempre (a confirmar).** Todo membro do Dossiê precisa de autorização SCR utilizável antes da execução, também na pesquisa própria. Na pesquisa própria, o destinatário é o e-mail da conta (e o celular, se confirmado). Razão: um só fluxo de consentimento, com código, IP e trilha.
10. **D10 — Escopo de reuso (a confirmar).** Utilizável = `status = 'authorized'` e `expires_at > now()`, do mesmo Bureau, do mesmo Titular e do mesmo comprador (`scr_authorizations.client_profile_id`; nulo para pedido de balcão sem comprador). Um pedido `pending` ainda no prazo, no mesmo escopo, também é reaproveitado. Razão: o titular consentiu no contexto de um comprador.
11. **D11 — Prazos (a confirmar).** Autorização: 365 dias (009). Pedido de autorização: expira 7 dias depois do envio (`scr_authorizations.request_expires_at`). A confirmação de um pedido expirado responde `expired` e marca a linha `expired`. Razão: #43 ("expiração libera a reserva").
12. **D12 — Contato do terceiro.** O comprador informa e-mail (obrigatório) e celular (opcional) do titular. O contato fica em `scr_authorizations` (`email`, `phone_e164`), nunca no Titular. Contato igual ao e-mail ou ao celular do comprador é recusado (`contact_is_buyer`). Um Titular que já existe no Bureau não muda. Razão: o comprador não altera o cadastro de outro e não autoriza a si mesmo como terceiro.
13. **D13 — Canal do pedido de autorização (a confirmar).** E-mail sempre. WhatsApp também quando há celular, pelo template novo `scr_authorization` (WhatsApp v1, `pt_BR`, parâmetros `clientName`, `authorizedName`, `code`, `url`). Razão: #43 e M4 ("precisa de template aprovado").
14. **D14 — Carry-over do M5 (posse do documento).** A equipe nunca recebe `holders.email` como destinatário padrão quando o Titular se cadastrou sozinho (`holders.created_by = holders.client_profile_id`). `resolveScrContact` devolve `holder_email` nulo nesse caso. `open_order` nunca usa `holders.email`. Razão: o e-mail do autocadastro pode não ser do dono do documento.
15. **D15 — Perfil de sistema por Bureau.** `profiles.is_system` (só papel `operator`). Um trigger em `bureaus` cria o perfil "Sistema" com um `"user"` sem `account` (sem login). A migration faz o backfill. `auth_profile_for_session` não devolve perfil de sistema. A lista da equipe o esconde. Só o owner muda `is_system`. Razão: a execução assíncrona usa a RLS de equipe e reaproveita `executeConsultation`, liquidação e notificação, sem novas funções `SECURITY DEFINER`.
16. **D16 — Tick.** `POST /api/internal/orders/tick`, autenticado pelo mesmo segredo `NOTIFICATIONS_DISPATCH_SECRET`. O serviço cron do M4 chama `ORDERS_TICK_URL` depois do dispatch, quando a variável existe. `due_order_bureaus()` devolve os Bureaus com trabalho. Para cada Bureau, com a identidade de sistema, em ordem: expira pedidos SCR, cancela pedidos parados, envia pedidos SCR, promove pedidos, executa (no máximo 5 por tick no total), gera parecer IA, libera pedidos online. Razão: sem infraestrutura nova (M4 D1).
17. **D17 — Concorrência da execução.** O claim faz `state = 'executing'`, `lease_until = now() + 5 min`, `attempts + 1` com `for update skip locked`. Lease vencida volta a executar com `reuseExisting: true`. O operador usa o mesmo claim em "Executar agora". Razão: dois ticks nunca chamam a DEPS duas vezes para o mesmo pedido.
18. **D18 — Balcão e pagamento (a confirmar).** O pedido de balcão nasce `awaiting_payment`. `refresh_order_state` move para `awaiting_authorization` ou `ready` quando a soma dos pagamentos não anulados é maior ou igual ao preço. Anulação antes da execução volta para `awaiting_payment`. Sem pagamento completo em 7 dias: `cancelled` (`payment_timeout`) e liberação do custo. Razão: M3b decisão 5 ("libera o pedido de balcão no M6").
19. **D19 — Comprador no balcão.** Opcional. É um perfil `client` ativo do mesmo Bureau. O operador cria a conta pelo convite existente (`inviteHolderToPortal`). Sem comprador, o pedido não é liberado no portal: a equipe entrega o PDF atual. Razão: "cadastrar cliente" reaproveita M1 e M5.
20. **D20 — Liberação e revogação (a confirmar).** Online: libera sozinho no tick depois da conclusão (e do parecer IA, se comprado). Balcão: só "Liberar" do operador. "Revogar" volta o pedido para `completed`, exige motivo e não avisa o cliente. As duas ações gravam auditoria (`order.release`, `order.revoke`) e evento na timeline na mesma transação. Razão: #45.
21. **D21 — Parecer IA (a confirmar).** Com `with_ai`, o pedido concluído fica `ai_status = 'pending'`. O tick gera o parecer: PF e PJ, parecer da consulta (`ai_reports`); PJ completo, parecer consolidado (`dossiers`). Até 3 tentativas. Depois, `ai_status = 'failed'`, a entrega segue sem parecer e o painel da equipe mostra "Parecer IA falhou". Razão: a entrega não fica presa pela IA.
22. **D22 — Aviso de liberação.** Template novo `research_released` (e-mail v1 e WhatsApp v1, parâmetros `clientName`, `url`). E-mail sempre. WhatsApp também quando `profiles.notification_channel = 'whatsapp'` (M5 decisão 13). Chave de idempotência `research_released:<dossiê>:<released_at em epoch>`. Razão: #46 ("e-mail e WhatsApp") e #34.
23. **D23 — RLS do cliente.** O cliente lê as próprias linhas de `dossier_orders` em todos os estados. Ele lê `dossiers`, `consultations`, `bureau_results` e `ai_reports` só de pedido próprio em `released`. Ele não lê Titular de terceiro, `bureau_payloads`, custo nem `scr_authorizations`. Ninguém insere em `dossier_orders` fora de `open_order`. O cliente não altera `dossier_orders`. Razão: #65.
24. **D24 — Identificação do titular para o cliente.** O pedido grava `subject_name` e `subject_document_masked` (máscara do M5). Na pesquisa de terceiro, são os dados que o comprador digitou. Razão: o cliente não lê o Titular de terceiro.
25. **D25 — Fonte do produto DEPS (M2 decisão 13).** `open_order` grava em `dossiers.product` e `consultations.product` o `deps_product` da versão vigente do produto. Sócio PF do PJ completo usa a versão vigente de `consulta_pf`. A execução passa `consultations.product` em `options.product`. O cliente real procura o identificador por esse nome na lista `produtos` do login. Saem `depsProductName()` e `DEPS_PRODUTO_PF|PJ`. Razão: uma só fonte do nome DEPS.
26. **D26 — Cotação.** Cliente: preço de `public_bureau_catalog(slug)` do Bureau dele, custo enviado `0`; `reserve_order` resolve e grava o custo (o modo online já faz isso). Equipe: `quoteOrder` (M2). Razão: o cliente não lê custo (M3b).
27. **D27 — Posse do pedido online.** A 022 refaz `reserve_order` com uma só mudança: o pedido online pertence ao comprador por `dossier_orders.client_profile_id = app_user_id()`, não pelo Titular. Razão: na pesquisa de terceiro o Titular não é do comprador.
28. **D28 — Só autorização própria.** Pedido novo grava `scr_mode = 'internal'`. O modo `deps` fica só nas linhas antigas. Razão: o fluxo da DEPS chama a DEPS sem reserva e não tem trilha por titular.
29. **D29 — Permissões.** Nenhuma nova. Equipe: `consultations:write` (abrir, executar, cancelar, liberar, revogar) e `counter:write` (pagamento). Cliente: `portal:write` (pedir) e `portal:read` (listar, ver, baixar). Superadmin em suporte não abre pedido de balcão nem libera (mesma regra de `counterWriter`). Razão: os papéis do M1 já cobrem.
30. **D30 — PDF (a confirmar).** O cliente baixa o PDF da entrega liberada em `/portal/pesquisas/<id>/pdf`, com `renderDossierPdf` e o timbrado atual. Razão: o timbrado já é a marca da plataforma no portal.
31. **D31 — Trilha por titular (#43).** Timeline do Titular: `order.opened`, `scr.requested`, `scr.self_authorized` / `scr.self_refused` (009), `scr.expired`, `order.cancelled`, `order.released`, `order.revoked`, `query.executed`. Auditoria `order.open|cancel|fail|complete|release|revoke` e `settlement.*` (M3b). Nunca documento, e-mail ou telefone sem máscara em metadata.
32. **D32 — Código SCR com `node:crypto`.** `generateCode` usa `randomInt` (alfabeto atual, 6 caracteres). Razão: o código é a credencial do consentimento.

## Estados do pedido

| Estado | Significado | Sai para |
|---|---|---|
| `awaiting_payment` | balcão sem pagamento completo | `awaiting_authorization`, `ready`, `cancelled` |
| `awaiting_authorization` | falta autorização utilizável de algum membro | `ready`, `awaiting_payment`, `cancelled` |
| `ready` | pago e autorizado; na fila do tick | `executing`, `awaiting_authorization`, `awaiting_payment`, `cancelled` |
| `executing` | lease ativa; DEPS em curso | `executing` (lease vencida), `ready` (transitório), `completed`, `failed` |
| `completed` | capturado; aguarda parecer IA e/ou liberação | `released` |
| `released` | entrega visível ao comprador | `completed` (revogação) |
| `failed` | falha terminal; reserva liberada | — |
| `cancelled` | recusa, expiração, prazo de pagamento ou cancelamento da equipe; reserva liberada | — |

Dinheiro por estado: reserva de `open_order` até `completed` (captura) ou `failed` / `cancelled` (liberação). Nenhum outro estado move saldo.

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `/portal` (alteração) | `client` | cartão "Suas pesquisas" com as 5 últimas e link para a lista; link "Pesquisas" no topo |
| `/portal/pesquisas` | `client` | lista: produto, titular (nome e documento mascarado), estado, data, preço |
| `/portal/pesquisas/nova` | `client` | produto, "Eu mesmo" ou "Outra pessoa" (nome, CPF/CNPJ, e-mail e celular do titular), parecer IA, preço total, saldo, "Confirmar pedido" |
| `/portal/pesquisas/[id]` | `client` | estado e motivo; se liberada: relatório, parecer IA e "Baixar PDF" |
| `/portal/pesquisas/[id]/pdf` | `client` | PDF da entrega liberada |
| `/dossiers/new` (alteração) | `operator`, `bureau_admin` | pedido de balcão: produto, parecer IA, comprador (opcional), titular, contato, sócios (PJ completo) |
| `/consultations/new` (alteração) | equipe | redireciona para `/dossiers/new` |
| `/dossiers/[id]` (alteração) | equipe | painel "Pedido": estado, motivo, comprador, preço, pago, parecer IA, "Registrar pagamento", "Executar agora", "Cancelar", "Liberar", "Revogar" |
| `/dossiers` (alteração) | equipe | selo do estado do pedido |
| `/autorizacao-scr/[token]` (alteração) | público | mensagem para pedido expirado |
| `/settings/users` (alteração) | `bureau_admin` | esconde o perfil de sistema |

## Fora do escopo

- Estorno após captura, reembolso ao cliente, uso de `reversal` (D7).
- PJ completo no autoatendimento (D8).
- KYC ou prova de posse do documento (D9).
- Cancelamento do pedido pelo cliente. A expiração cobre o abandono.
- Aviso ao cliente em falha, cancelamento ou revogação. O estado aparece na lista.
- Cartão, cupom, preço por volume.
- Convite por WhatsApp. O convite segue no e-mail do Better Auth (#36).
- Editor de templates e arte nova de PDF.

## Critérios de pronto

Cada critério aponta para o teste que o prova.

- Pedido online próprio e de terceiro: Dossiê, consultas, pedido e linhas SCR numa transação; a reserva sai da carteira do cliente; saldo insuficiente não deixa linha (Task 1, 3).
- Pedido de terceiro não muda o Titular existente; contato igual ao do comprador é recusado (Task 1).
- `reserve_order` aceita o pedido de terceiro do comprador e recusa o de outro cliente (Task 1).
- Autorização utilizável no mesmo escopo deixa o pedido `ready` na abertura; outro comprador gera pedido novo (Task 1).
- Pedido de autorização sai por e-mail, e por WhatsApp com celular; expira em 7 dias; a confirmação expirada responde `expired` (Task 1, 2).
- Recusa ou expiração cancelam o pedido e liberam a reserva; a timeline do Titular registra cada passo (Task 3, 4).
- Balcão: reserva o custo do Bureau; pagamento ≥ preço libera para autorização; anulação volta; 7 dias sem pagamento cancela e libera (Task 1, 3, 4).
- Dois ticks nunca executam o mesmo pedido; lease vencida volta a executar (Task 3).
- Sucesso da DEPS captura: online debita `P` do cliente e grava `P − C` a repassar; balcão debita `C` do Bureau (Task 4, cenário ponta a ponta).
- Erro transitório reagenda com espera; 5ª falha, `no_data` e `payload_incompatible` falham e liberam (Task 4).
- Parecer IA gerado quando comprado; falha em 3 tentativas não prende a entrega (Task 4).
- Online libera sozinho; balcão libera só pelo operador; revogar exige motivo; as duas ações auditam (Task 3, 5).
- Aviso de liberação por e-mail sempre e por WhatsApp quando o canal é WhatsApp (Task 3).
- RLS: o cliente lê só os próprios pedidos; lê a entrega só em `released`; não lê Titular de terceiro, payload, custo nem SCR; ninguém insere pedido fora de `open_order` (Task 1).
- O PDF do cliente só sai para entrega liberada do próprio cliente (Task 5).
- O perfil de sistema não entra no login e não aparece na equipe (Task 1, 6).
- O nome DEPS vem de `product_versions.deps_product`; sem `DEPS_PRODUTO_*` (Task 2, 6).
- Telas do portal e do balcão funcionam (Task 6, 7; verificação visual).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) A Meta aprova os templates WhatsApp `scr_authorization` e `research_released` (`pt_BR`, utility).
- (post-deploy) Uma pesquisa real na DEPS com o nome de produto de `product_versions` encontra o identificador no login.
- (post-deploy) O cron do stack chama `ORDERS_TICK_URL` a cada minuto e o log não mostra dados pessoais.
- (post-deploy) Um aviso real de liberação chega por e-mail e por WhatsApp.

## Riscos

- **Perfil de sistema:** uma identidade de equipe sem login. Proteções: sem `account`, recusado por `auth_profile_for_session`, `is_system` imutável para `app_runtime`, uso só no tick. A rota do tick depende do segredo do cron.
- **Custo DEPS sem receita (D6):** cada falha terminal custa à plataforma.
- **Consentimento por e-mail (D9, D12):** o código prova o controle do e-mail, não a identidade. Um comprador pode informar um e-mail que ele controla. A recusa de contato igual ao do comprador reduz, não elimina. O IP do consentimento fica gravado.
- **Latência:** pedido SCR, execução e liberação online saem no tick, em até ~1 minuto cada passo.
- **Tick longo:** até 5 chamadas DEPS por tick. O cron espera 55 s. Uma DEPS lenta deixa pedidos para o tick seguinte (a lease cobre o corte).
- **Compilação entre ondas:** a Task 5 remove ações que os componentes da Task 6 ainda importam. `npm run type-check` passa só no fim da onda 5.
- **Métricas do superadmin:** `platform_bureau_metrics` conta o perfil de sistema como operador (+1 por Bureau).
- **Dados antigos:** não há produção. Dossiês sem pedido (seed de dev) ficam sem painel "Pedido".
- **Templates da Meta:** sem aprovação, o WhatsApp falha com `template_unavailable`; o e-mail continua.

## Plano de tarefas (resumo para o plano de execução)

| Task | Agente | Conteúdo | Depende de |
|---|---|---|---|
| 1 | `database-architect` | migration `022_orders_delivery.sql`: `dossier_orders`, guard, perfil de sistema, colunas SCR, `open_order`, `refresh_order_state`, `reserve_order`, `confirm_public_scr_authorization`, `due_order_bureaus`, RLS do cliente, templates; testes | — |
| 2 | `backend-specialist` | produto DEPS por nome no cliente real, setup sem `DEPS_PRODUTO_*`, pedido SCR por WhatsApp e prazo, código com `randomInt`, contato do autocadastro, `expired` na confirmação; testes | 1 |
| 3 | `backend-specialist` | `src/lib/orders/` (abrir, estado, claim, concluir, falhar, cancelar, liberar, revogar, expirar, leituras), validadores, ligação com pagamento de balcão; testes | 1 |
| 4 | `backend-specialist` | execução do pedido, parecer IA, tick, rota, cron, leitores de configuração; teste ponta a ponta do dinheiro | 1, 2, 3 |
| 5 | `backend-specialist` | Server Actions do cliente e da equipe, PDF do cliente, remoção das ações antigas; testes | 3, 4 |
| 6 | `frontend-specialist` | telas do balcão e da equipe | 5 |
| 7 | `frontend-specialist` | telas do portal | 5 |
| 8 | `documentation-writer` | architecture, PRODUCT, notifications, runbook do tick | 1 |

Ondas: {1} → {2, 3, 8} → {4} → {5} → {6, 7}. Um PR. Review uma vez, no fim, com `code-reviewer` e `security-reviewer`.

## Ajustes nas issues

- #42, #43, #44, #45, #46, #65: fechar com o PR.
- #27 (M3): fechar com o PR. O M6 liga reserva, captura e liberação ao pedido.
- #34 (M4): fechar com o PR. O M6 usa `notification_channel` no envio (D22).
- #36 (M4): fechar com o PR. Comentário: o M6 entrega as versões WhatsApp de `scr_authorization` e `research_released`; o convite segue no e-mail de definição de senha do Better Auth (link de uso único com expiração) e não ganha versão WhatsApp.
- Issue nova no backlog: "Estorno após captura e reembolso ao cliente" (D7).
