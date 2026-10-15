# M5 — Contas de cliente: Desenho

**Data:** 2026-10-15
**Status:** rascunho (D1–D4 aprovadas pelo usuário; o restante aguarda revisão)
**Milestone:** M5 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #37, #38, #39, #40, #41 (parcial). Ver "Ajustes nas issues".
**Depende de:** M3 (carteira do cliente, `credits:topup`, `requestClientTopupAction`), M4 (fila de notificações, templates versionados, canal WhatsApp). Usa o modelo de função `SECURITY DEFINER` da 009 e da 020.

## Objetivo

Dar ao cliente PF/PJ uma conta própria num Bureau:
- O cliente cria a conta sozinho em `/b/<slug>/cadastro`, com CPF/CNPJ validado, e entra no portal na hora.
- O cliente confirma o e-mail por link. Só o e-mail confirmado libera a compra de créditos.
- O cliente confirma o telefone por código no WhatsApp. O telefone confirmado libera o canal WhatsApp nas preferências.
- O cliente aceita os termos de uso e a política de privacidade. O aceite guarda versão, data, IP e user-agent. Versão nova pede aceite novo.
- O portal ganha "Perfil e segurança".

O M5 não muda o login, o MFA da equipe nem o convite do operador (`inviteHolderToPortal`).

## Decisões do usuário (aprovadas, não reabrir)

| # | Decisão |
|---|---|
| D1 | **Portal.** "Pesquisas e entregas liberadas" vai para o M6. O M5 entrega carteira e extrato (já existe em `/portal/credits`), perfil e segurança, e os fluxos de confirmação e de termos. Sem lista de dossiês e sem RLS de dossiê para o cliente. |
| D2 | **Bloqueio de compra.** Só o e-mail confirmado bloqueia `credits:topup` (`requestClientTopupAction` e a tela). O telefone confirmado é exigido para o canal WhatsApp, mas nunca bloqueia compra. |
| D3 | **Documento já cadastrado.** Autocadastro com CPF/CNPJ que já existe como Titular naquele Bureau (com ou sem `client_profile_id`) é recusado com a mensagem "Documento já cadastrado neste Bureau. Peça o acesso ao Bureau." O operador liga a conta pelo `inviteHolderToPortal` existente. Nunca ligar sozinho. |
| D4 | **Textos legais.** Ficam na tabela `legal_documents`, semeada por migration. Versão nova entra por migration, sem editor. `/termos` e `/privacidade` mostram a versão vigente. O texto semeado é provisório (pt-BR) e é trocado antes da abertura ao público (critério post-deploy). |

## Ponto de partida

- `authConfig` (`src/lib/auth/config.ts`) tem `disableSignUp: true`. `src/lib/auth/CLAUDE.md` proíbe desligar. O Better Auth não cria conta.
- `createInvite` (`src/lib/auth/invite.ts`) é o modelo de criação: `"user"` → `account` (`provider_id = 'credential'`, `issuer = 'local:credential'`, hash de `hashPassword` de `better-auth/crypto`) → `profiles`. O convite grava `email_verified = true`.
- O trigger `profiles_create_client_wallet` (015) cria a carteira zerada em todo INSERT de perfil `client`.
- `enqueue_notification` (020) recusa `client` e contexto ausente (`not_allowed`). O cadastro é anônimo e a confirmação de telefone roda como `client`: os dois precisam de outro caminho.
- `confirm_public_scr_authorization` (009) é o modelo de função pública: dono `auth_profile_lookup`, `search_path` fixo, `revoke` de `public`, `grant execute` só para `app_runtime`, grava IP do consentimento.
- `app_runtime` tem SELECT, INSERT e UPDATE em todas as colunas de `profiles`, e `profiles_update` deixa o próprio usuário mudar a própria linha. Coluna nova de segurança em `profiles` precisa de proteção própria.
- `"user".email` é único na plataforma (`user_email_lower_uidx`). O login é único (`/login`).
- `/b/[slug]` mostra "Cadastro em breve". O portal (`src/app/(portal)/`) tem início e créditos.
- `/change-password` só serve para quem tem `must_change_password` (o layout manda os outros para `/`).
- `confirmScrSelfAuthorization` lê o IP de `x-forwarded-for` (primeiro item) ou `x-real-ip`.

## Decisões

1. **Cadastro sem o Better Auth.** O `disableSignUp` fica ligado. A Server Action `registerClientAction` (`src/actions/register.ts`) roda sem sessão:
   - valida com zod (`src/lib/validators/register.ts`): slug, tipo `PF | PJ`, dígito do CPF/CNPJ (`isValidCPF`, `isValidCNPJ`), nome, e-mail, celular, senha (`passwordSchema`), confirmação da senha, caixa de aceite marcada e as versões dos termos que a tela mostrou;
   - normaliza o celular com `toE164`;
   - gera o hash com `hashPassword`;
   - lê IP e user-agent dos headers;
   - gera o token do e-mail;
   - chama uma função SQL, `register_client`, que faz tudo numa transação.
   Depois do sucesso, o formulário chama `authClient.signIn.email` com o e-mail e a senha digitados e vai para `/portal`. O login passa pelo rate limit do Better Auth, como em `/login`.
2. **`register_client` (021, `SECURITY DEFINER`).** Na ordem:
   - limite por IP (decisão 8);
   - Bureau ativo pelo slug, senão `bureau_not_found`;
   - versões aceitas iguais às vigentes, senão `outdated_terms`;
   - Titular com o mesmo `document_digits` no Bureau: `document_in_use` (D3);
   - e-mail já usado em `"user"`: `email_in_use`;
   - grava `"user"` (`email_verified = false`), `account`, `profiles` (`client`, Bureau, `phone_e164`), `holders` (tipo, nome, documento, e-mail, celular, `client_profile_id` e `created_by` = o perfil novo), dois aceites, a auditoria `client.register` (com IP e user-agent; metadata só com o tipo) e o desafio de e-mail com a notificação.
   - Devolve `(ok, reason, user_id)`.
3. **Uma conta por e-mail na plataforma.** O mesmo CPF/CNPJ pode ter conta em Bureaus diferentes (#37). Cada conta precisa de um e-mail diferente, porque o login é único e `"user".email` é único.
4. **Tabelas novas (migration `021_client_accounts.sql`).**
   - `profiles` ganha `phone_e164` (E.164), `phone_verified_at` e `notification_channel` (`email | whatsapp`, padrão `email`). CHECK: `whatsapp` exige telefone confirmado.
   - `legal_documents`: tipo (`terms | privacy`), versão, título, corpo em Markdown, data de publicação. Imutável. A versão vigente é a maior com `published_at <= now()`.
   - `legal_acceptances`: perfil, documento (versão), data, IP, user-agent. Só INSERT.
   - `verification_challenges`: perfil, tipo (`email | phone`), alvo (o e-mail ou o telefone do desafio), hash SHA-256 do segredo, tentativas, validade, consumo.
   - `client_register_attempts`: IP e data de cada tentativa de cadastro. Guarda 1 dia.
   - Só funções da 021 escrevem nessas tabelas e nas três colunas novas de `profiles`. Um trigger recusa a escrita direta de `app_runtime` nessas colunas.
5. **Segredos.** O servidor gera o segredo com `node:crypto`: token de e-mail com 32 bytes em base64url (43 caracteres), código de telefone com 6 dígitos. A função SQL calcula o SHA-256 e guarda só o hash no desafio. O segredo cru existe só no parâmetro da notificação (o link ou o código), que o worker do M4 apaga depois do envio. Nunca em log, auditoria ou tabela de desafio.
6. **Confirmação de e-mail.** Link `/cadastro/confirmar-email?token=...`, válido por 24 h, uso único. A página mostra o botão "Confirmar e-mail"; o clique chama `confirm_email_verification` (POST, sem sessão: o token é a credencial). Um leitor de link no e-mail não confirma sozinho. Pedido novo invalida o link anterior. Reenvio pelo banner do portal: 1 envio a cada 60 s e no máximo 5 por hora.
7. **Confirmação de telefone.** O cliente informa o celular em `/portal/perfil`. O código vai pelo template `phone_verification` do WhatsApp, vale 10 minutos e aceita 5 tentativas; na 5ª errada, o desafio cai. Telefone novo apaga a confirmação anterior e volta o canal para `email`. Mesmos limites de envio do e-mail.
8. **Limite do cadastro público.** `register_client` grava cada tentativa (com sucesso ou não) em `client_register_attempts` e recusa a 11ª do mesmo IP na mesma hora (`rate_limited`). Contar só a auditoria de sucesso deixaria a enumeração de e-mail e documento sem limite.
9. **Notificação sem staff.** A 021 cria `enqueue_system_notification` (interna, sem `grant` para `app_runtime`). Ela repete as regras da 020 (template ativo, parâmetros iguais à lista, hash do destinatário, evento `queued`), recebe o Bureau e o autor (o próprio perfil) do chamador e lança erro em vez de devolver motivo. Só as funções da 021 a chamam. Templates semeados:
   - `email_verification` (e-mail v1, parâmetros `clientName`, `url`);
   - `phone_verification` (WhatsApp v1, `verification_code`, `pt_BR`, parâmetro `code`). É um template da categoria autenticação da Meta, com botão "copiar código". O payload leva o código no corpo e no botão.
10. **Termos.** O aceite guarda as versões que a tela mostrou; versão diferente da vigente volta `outdated` e a tela recarrega. O layout do portal manda para `/portal/termos` quem não aceitou as versões vigentes. Isso inclui o cliente convidado pelo operador, no primeiro acesso, e todo cliente depois de uma versão nova. `/portal/termos` fica num grupo de rotas próprio, fora desse redirecionamento.
11. **Bloqueio de compra (D2).** `requestClientTopupAction` lê o estado da conta dentro de `reserveCharge`, antes de reservar a linha PIX, e recusa e-mail não confirmado com "Confirme seu e-mail antes de comprar créditos.". A tela de créditos troca o botão de recarga por esse aviso.
12. **Perfil e segurança.** `/portal/perfil` mostra nome, e-mail, documento mascarado e telefone; confirma o telefone; escolhe o canal (WhatsApp só com telefone confirmado); troca a senha com `authClient.changePassword` (o handler já força `revokeOtherSessions`); e tem "Sair dos outros dispositivos" (`authClient.revokeOtherSessions`).
13. **Preferência de canal (#34).** O M5 só grava e mostra `profiles.notification_channel`. O M6 usa o valor para escolher o canal.
14. **Rotas públicas.** O middleware libera `/cadastro/`, `/termos` e `/privacidade`. `/b/` já é público. A 021 acrescenta `cadastro`, `termos` e `privacidade` aos slugs reservados, como as outras rotas de primeiro nível.
15. **Driver fake do WhatsApp.** Com `WHATSAPP_DRIVER=fake` e `NODE_ENV` diferente de `production`, o canal escreve no console o template, o destinatário mascarado e os parâmetros. Assim o desenvolvedor lê o código. Em produção o driver fake já é recusado.

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `/b/[slug]` (alteração) | público | link "Criar conta" no lugar de "Cadastro em breve" |
| `/b/[slug]/cadastro` | público | formulário PF/PJ: nome ou razão social, CPF ou CNPJ, e-mail, celular, senha, confirmação, aceite com links para `/termos` e `/privacidade` |
| `/cadastro/confirmar-email` | público | botão "Confirmar e-mail"; resultado: confirmado, link inválido ou expirado; link para o portal ou o login |
| `/termos`, `/privacidade` | público | versão vigente, com número e data |
| `/portal/termos` | `client` | os dois textos vigentes e o botão "Aceitar e continuar" |
| `/portal` (todas, alteração) | `client` | banner "Confirme seu e-mail" com "Reenviar e-mail" enquanto o e-mail não está confirmado; link "Perfil" no topo |
| `/portal/perfil` | `client` | dados da conta, telefone e código, canal de notificação, troca de senha, sair dos outros dispositivos |
| `/portal/credits` (alteração) | `client` | sem e-mail confirmado: aviso no lugar do botão de recarga |

## Fora do escopo

- Pesquisas e entregas liberadas no portal, RLS de dossiê para o cliente (M6).
- Uso de `notification_channel` no envio (M6).
- Estado da conta do cliente na tela do Titular para a equipe (decisão 9 do pedido; não é trivial e não tem critério de issue).
- Troca de e-mail, exclusão de conta e exportação de dados (LGPD) pela tela.
- PJ com vários usuários.
- Editor de textos legais.
- CAPTCHA no cadastro.
- Redefinição de senha por WhatsApp.

## Critérios de pronto

Cada critério aponta para o teste que o prova.

- O cadastro cria usuário, conta, perfil, Titular, carteira, aceites, auditoria, desafio e notificação numa transação; uma falha não deixa linha (Task 1, 3).
- CPF/CNPJ com dígito errado é recusado (Task 2).
- O mesmo documento cria conta em outro Bureau com outro e-mail; no mesmo Bureau, é recusado com ou sem `client_profile_id` (Task 1, 3).
- A 11ª tentativa do mesmo IP na mesma hora é recusada (Task 1).
- O link de e-mail expira em 24 h, é de uso único, e o pedido novo invalida o anterior (Task 1).
- O reenvio respeita 60 s e 5 por hora, no e-mail e no telefone (Task 1).
- O código de telefone expira em 10 min e cai na 5ª tentativa errada (Task 1).
- Só o hash fica no desafio; `app_runtime` não lê `verification_challenges` nem escreve nas colunas novas de `profiles` (Task 1).
- Auditoria e log não têm documento, e-mail sem máscara, telefone sem máscara, token nem código (Task 1, 3).
- O aceite grava versão, data, IP e user-agent; versão nova pede aceite novo (Task 1, 3).
- Compra recusada sem e-mail confirmado; telefone não confirmado não bloqueia compra (Task 3).
- WhatsApp como canal exige telefone confirmado (Task 1, 3).
- As rotas públicas novas passam sem sessão (Task 2).
- Telas do cadastro, da confirmação, dos termos e do perfil funcionam (Task 4, 5; verificação visual).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) A Meta aprova o template `verification_code` (autenticação, `pt_BR`) e um código real chega ao WhatsApp.
- (post-deploy) O texto jurídico real entra como versão 2 dos termos e da política (migration nova) antes da abertura do cadastro ao público.
- (post-deploy) Um e-mail real de confirmação chega e o link confirma a conta.

## Riscos

- **Enumeração:** `email_in_use` e `document_in_use` (D3) dizem que o e-mail ou o documento existem. O limite por IP reduz a varredura. Não há CAPTCHA.
- **IP do cliente:** vem de `x-forwarded-for`. Ele só vale atrás do Traefik, que reescreve o header. IP inválido vira nulo, e todas as tentativas sem IP dividem o mesmo limite (em dev, todas).
- **Uma conta por e-mail:** o cliente com conta em dois Bureaus precisa de dois e-mails.
- **Hash do código:** 6 dígitos têm só 10⁶ valores; o hash não protege um dump do banco. A tabela não tem grant para a aplicação e o código vale 10 minutos.
- **Latência:** o e-mail e o código saem pelo worker do M4, em até ~1 minuto.
- **Template da Meta:** sem aprovação, o código falha com `template_unavailable` ou `channel_not_configured`. A compra continua liberada (D2).
- **Rota `/portal/termos` em outro grupo:** dois grupos de rota com `portal/` dentro. `npm run build` confirma que o Next aceita.
- **Slugs reservados:** a 021 falha se um Bureau já usa `cadastro`, `termos` ou `privacidade`. Consulte antes do deploy.
- **Clientes antigos:** todo cliente existente vê `/portal/termos` no próximo acesso. Clientes convidados já têm e-mail confirmado.
- **Role do worker:** o worker usa `app_dispatch` (`DISPATCH_DATABASE_URL`); `app_webhook` só atende webhooks. A 021 não dá privilégio de tabela a nenhuma das duas; `claim_notifications` já lê as notificações novas.

## Plano de tarefas (resumo para o plano de execução)

| Task | Agente | Conteúdo | Depende de |
|---|---|---|---|
| 1 | `database-architect` | migration `021_client_accounts.sql`: colunas, tabelas, trigger, RLS, grants, funções, slugs, seeds; testes de integração e casos de RLS | — |
| 2 | `backend-specialist` | validadores, segredos, IP e user-agent, rotas públicas, botão de código e log do driver fake no WhatsApp; testes | — |
| 3 | `backend-specialist` | queries de conta, ações de cadastro e de conta, bloqueio da recarga; testes | 1, 2 |
| 4 | `frontend-specialist` | cadastro, confirmação de e-mail, `/termos`, `/privacidade`, `/portal/termos` | 3 |
| 5 | `frontend-specialist` | layout do portal (termos e banner), `/portal/perfil`, aviso na tela de créditos | 3 |
| 6 | `documentation-writer` | docs/architecture.md, PRODUCT.md, docs/operations/notifications.md | 1 |

Ondas: {1, 2} → {3, 6} → {4, 5}. Um PR. Review uma vez, no fim, com `code-reviewer` e `security-reviewer`.

## Ajustes nas issues

- #37, #38, #39, #40: fechar com o PR.
- #41: fechar com o PR, exceto "Pesquisas e entregas liberadas". Mover esse critério para uma issue nova do M6 (texto no plano).
- #34: o critério "Preferência de canal por destinatário" fica com o M5 para guardar o valor e com o M6 para usá-lo.
