# Notificações push e atalho no aparelho — design

Data: 2026-10-26. Status: aguardando aprovação.

## Intenção

O cliente instala o portal como atalho na tela inicial (Android e iPhone) e liga as notificações do aparelho. Assim ele sabe na hora quando algo muda, sem abrir o app ou o e-mail.

## Metas

- Tela **Conta › Notificações** (`/portal/notificacoes`), ao lado de Afiliação, Termos de uso e Sair.
- A tela tem um botão para ligar e desligar as notificações do aparelho atual.
- A tela explica como instalar o atalho:
  - Android: botão "Instalar" (evento `beforeinstallprompt`).
  - iPhone: passo a passo "Compartilhar › Adicionar à Tela de Início". O iPhone só recebe push com o app instalado (iOS 16.4 ou mais novo). O botão de ligar só aparece depois da instalação.
- Quatro eventos geram push para o cliente (dono do pedido):
  1. Um sócio autorizou a consulta de crédito (SCR). Cada sócio que autoriza gera um aviso.
  2. A consulta ficou pronta (já existe aviso por e-mail e WhatsApp; soma o push).
  3. Comissão de afiliado recebida.
  4. Comissão disponível para saque (passou de pendente para disponível).
- Clicar no aviso abre a tela certa: pesquisa (`/portal/pesquisas/<id>`) para os eventos 1 e 2; `/portal/afiliacao` para os eventos 3 e 4.

## Fora do escopo

- Lista ou histórico de avisos recebidos. A tela só liga e desliga.
- Preferência por tipo de evento. O aparelho recebe os quatro ou nenhum.
- Push para os sócios. Eles não têm conta; continuam a receber o pedido de autorização por e-mail e WhatsApp.
- Push para o Bureau, operadores e superadmin.
- Modo offline do app (cache de páginas). O service worker só trata push.

## Anti-metas

- Um push que expõe dado sensível (CPF, CNPJ, valor da consulta, nome do titular) na tela bloqueada. O texto é genérico.
- Um aviso duplicado quando o envio é repetido (idempotência por evento).
- Um push que chega a um aparelho que o cliente desligou.

## Estado atual (verificado no código)

- Canais: só e-mail e WhatsApp. `notifications.channel` e `notification_templates.channel` têm CHECK `in ('email','whatsapp')` (migration 020).
- Fila (outbox) e envio: `enqueueNotification` em `src/lib/notifications/queries.ts`, `runDispatch` em `src/lib/notifications/dispatch.ts`, cron `scripts/notifications-cron.mjs`, canais em `src/lib/notifications/channels/`.
- Evento 2 existe: `enqueueReleaseNotices` em `src/lib/orders/queries.ts`.
- Eventos 1, 3 e 4 não geram aviso hoje:
  - Evento 1: `confirm_public_scr_authorization` (SQL, migrations 009 e 022; chamada por `confirmPublicScrAuthorization` em `src/lib/scr/queries.ts`).
  - Evento 3: comissão gravada em `capture_order` e `apply_asaas_payment` (migration 027).
  - Evento 4: `release_due_commissions` (migration 027).
- PWA: `src/app/manifest.ts` existe. Não há service worker, push, VAPID nem `apple-touch-icon`. CSP já permite `worker-src 'self'`.
- Preferência do usuário hoje: `profiles.notification_channel` (e-mail ou WhatsApp), em `/portal/perfil`. Fica como está.

## Decisões de design (minhas; o cliente confirmou só o escopo acima)

- **Push é um canal novo, ao lado dos atuais.** Entra pelo mesmo caminho: tabela `notifications`, template, `claim_notifications`, retentativa. Nova migration (034) amplia os CHECK de canal para incluir `push`.
- **Cada aparelho tem a sua inscrição.** Nova tabela de inscrições push (perfil, endpoint único, chaves, user agent, datas), com RLS forçada e acesso mínimo. O envio faz uma entrega por inscrição ativa do perfil. Inscrição que o serviço de push recusa (410/404) é removida.
- **Eventos 1, 3 e 4 enviam só push** (sem e-mail ou WhatsApp novos), para não gerar ruído. O evento 2 mantém e-mail/WhatsApp e soma push.
- **Biblioteca `web-push` (npm)** com chaves VAPID em variáveis de ambiente. É uma dependência nova, mantida e padrão para esse uso.
- **Service worker** em `public/sw.js`, escopo `/`, só com os handlers `push` e `notificationclick`.
- **iPhone:** adicionar `apple-touch-icon` e metadados `appleWebApp` no layout raiz.
- **Gatilhos SQL:** os eventos 1, 3 e 4 nascem em funções SQL. Eles enfileiram pelo mesmo mecanismo das funções de sistema (`enqueue_system_notification`, migration 021), na mesma transação, com chave de idempotência por evento.
- **Textos genéricos**, por exemplo: "Um sócio autorizou sua consulta", "Sua consulta está pronta", "Você recebeu uma comissão", "Sua comissão está disponível para saque".
- **Ação do servidor** para inscrever e remover aparelho: zod, sessão e `hasPermission`, evento de auditoria na mesma transação, retorno `{ error: string | null }`.

## Regras fechadas na revisão (minhas; o cliente pode mudar)

- **Destinatário dos eventos 3 e 4:** o perfil do afiliado, que é um cliente do portal. Se o afiliado não tem perfil de cliente, o aviso não é criado.
- **Chaves de idempotência:** evento 1 por autorização de sócio (abrir o link de novo depois de confirmar não repete); evento 3 por comissão; evento 4 por afiliado e por execução de `release_due_commissions`, com um aviso único ("Você tem comissão disponível para saque"), não um por comissão.
- **Sem aparelho inscrito:** o aviso não é criado e não é guardado. Quem liga o push depois não recebe avisos antigos.
- **Evento 2:** o push soma ao envio atual, para todo cliente com aparelho inscrito, qualquer que seja `profiles.notification_channel`.
- **Sair da conta (logout):** remove a inscrição push do aparelho. Se outro perfil se inscreve no mesmo endpoint, a inscrição passa para o perfil novo (upsert por endpoint). O perfil anterior nunca recebe avisos no aparelho do outro.
  - Só o botão "Sair" explícito remove a inscrição; sessão expirada ou inativa (idle) mantém a inscrição (o upsert por endpoint já protege aparelho compartilhado).
- **Prazo de envio:** o cron do outbox roda a cada 60 s (`scripts/notifications-cron.mjs`). Esse atraso é aceito; o push usa o mesmo caminho.

## O que fica para quem constrói

- Forma exata da tabela, do CHECK e das funções SQL.
- Como o tipo de `recipient` do canal push mapeia para inscrições (a fila apaga `recipient` no estado final).
- Arquivos, nomes e testes. Testar: RLS da tabela nova, idempotência dos quatro gatilhos, remoção de inscrição inválida, detecção de iPhone sem instalação.
- Geração das chaves VAPID e documentação em `docs/operations/notifications.md` e `docs/setup.md`.
- Não editar migrations já aplicadas (033 é a última local).

## Verificação

- Testes automáticos dos itens acima (`npm run check`).
- Push real só se confirma em aparelho Android e iPhone instalados com HTTPS (critério `(post-deploy)`).
