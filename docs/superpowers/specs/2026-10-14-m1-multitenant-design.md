# M1 — Multi-tenant e domínio: Desenho

**Data:** 2026-10-14
**Status:** aprovado (decisões fechadas)
**Milestone:** M1 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #13–#21
**Plano:** [2026-10-14-m1-multitenant.md](../plans/2026-10-14-m1-multitenant.md)

## Objetivo

Vários Bureaus usam a mesma instalação. O banco isola os dados de cada Bureau, não só a aplicação. O domínio passa a ser Titular, Sociedade, Dossiê e Consulta. O superadmin cria Bureaus, convida o primeiro admin e entra em modo suporte com motivo auditado. Cada Bureau tem uma página pública em `/b/<slug>`.

## Ponto de partida (M0)

- Papéis `admin | consultant | client`. Políticas RLS só por papel, sem tenant.
- GUCs `app.user_id` e `app.user_role`, definidos em `withUserTransaction`.
- `crm_clients` mistura comprador, pesquisado e lead. O lote PJ (`batches` + `company_reports`) não grava a sociedade.
- Cerca de 80 arquivos usam as tabelas antigas. Cerca de 15 pontos comparam `role === "admin"`.
- Não existem `/b/<slug>`, área do superadmin nem convite por Bureau.

## Decisões

1. **Nomes em inglês.** Tabelas `bureaus`, `holders` (Titular), `holder_partnerships` (Sociedade), `dossiers` (Dossiê), `consultations` (mantida) e `support_sessions`. Toda consulta pertence a um dossiê (`dossier_id not null`). Os campos de `company_reports` entram em `dossiers`. A interface usa os termos pt-BR: Titular, Sociedade, Dossiê, Pesquisas. No enum `timeline_entity_type`, `'crm_client'` vira `'holder'`.
2. **Papéis.** Enum `user_role = superadmin | bureau_admin | operator | client`. Mapeamento: `admin` → `bureau_admin`, `consultant` → `operator`. `profiles.bureau_id` é nulo só para o superadmin (CHECK). O superadmin não vê dados pessoais fora do modo suporte.
3. **Contexto do tenant.** Terceiro GUC `app.bureau_id` e função `app_bureau_id()`. Toda tabela de tenant tem `bureau_id not null`. Exceção: `audit_logs.bureau_id` aceita nulo para eventos da plataforma. Toda política tem `bureau_id = app_bureau_id()` em USING e WITH CHECK. `DbIdentity` ganha `bureauId` e `supportSessionId` opcional. `auth_profile_for_session` devolve `bureau_id`.
4. **`settings` é global** (PK `key`). Só o superadmin grava. Leem `superadmin`, `bureau_admin` e `operator`; o `client` não lê. As telas de prompts e termo SCR vão para a área do superadmin. O admin do Bureau perde essas telas.
5. **Modo suporte ("entrar como").** Tabela `support_sessions(id, superadmin_id, bureau_id, reason, started_at, expires_at, ended_at)`. `reason` é obrigatório e não vazio. `expires_at` padrão: 1 hora. O superadmin só acessa tabelas de tenant com uma sessão de suporte ativa e do mesmo Bureau. Uma função SECURITY DEFINER verifica a sessão. A identidade carrega `supportSessionId`. `audit_logs` ganha `support_session_id`. Início e fim gravam auditoria. O SQL aplica a expiração, não só a interface.
6. **Unicidade do Titular.** `unique (bureau_id, document_digits)`. `document_digits` é a coluna gerada com só os dígitos do CPF/CNPJ. A auditoria nunca guarda o documento completo.
7. **Permissões.** `bureau_admin` = antigo `admin` sem `settings:write`. `operator` = antigo `consultant`. `superadmin` = `bureaus:manage`, `support:enter`, `settings:read`, `settings:write`; nada sobre dados de tenant sem sessão de suporte. `client` = `portal:read`, `portal:write`; a política do portal continua restrita ao tenant.
8. **Gateway SCR (008/009).** `confirm_public_scr_authorization` e o insert na timeline copiam `bureau_id` da linha de `scr_authorizations`. Grants de coluna e políticas do gateway passam a usar `bureau_id` e `entity_type = 'holder'`.
9. **Convites.** O superadmin cria o Bureau (nome, slug) e convida o primeiro `bureau_admin` por e-mail. O `bureau_admin` convida operadores e outros admins. O fluxo reaproveita o convite por redefinição de senha (`requestPasswordReset`). O código novo não copia os defeitos de `src/actions/users.ts`:
   - rejeita um e-mail que já tem perfil com papel ou Bureau diferente;
   - valida uuids com zod;
   - grava usuário, perfil e auditoria no cliente da transação.
10. **Página pública `/b/<slug>`.** A função SECURITY DEFINER `public_bureau_by_slug(slug text)` devolve só `name` e `slug` de Bureau ativo. Formato do slug: `[a-z0-9-]{3,40}`. Slugs reservados são rejeitados (`admin`, `api`, `login`, `b`, `portal`, `autorizacao-scr`, `superadmin`…). A página mostra o nome do Bureau, o link "Entrar" e o texto "cadastro em breve". Produtos chegam no M2; cadastro, no M5. O middleware trata `/b/` como público. Slug inexistente ou inativo devolve o mesmo 404.
11. **Telas.** "Pesquisas" lista Dossiês com filtro PF | PJ | PJ completo. A página do Titular PF mostra as empresas em que ele é sócio, as consultas e os dossiês. A página do Titular PJ mostra os sócios (com link) e os dossiês. As Sociedades nascem do quadro societário retornado pela DEPS ou informado pelo operador.
12. **Seed de teste compartilhado.** Um helper cria Bureau, usuários por papel e Titular. Todos os testes de integração usam esse helper.
13. **Pipeline depois das tasks.** O controlador roda o painel de review uma vez sobre o diff inteiro do M1, sintetiza, corrige e abre o PR. Ver o plano, seção "Pipeline pós-implementação".

## Modelo de dados

| Tabela | Tenant | Substitui | Pontos-chave |
|---|---|---|---|
| `bureaus` | é o tenant | — | `name`, `slug` único, `status active/inactive`; CHECK de formato e de slug reservado |
| `profiles` | `bureau_id` nulo só p/ superadmin | — | CHECK papel × Bureau; `unique (bureau_id, id)` para FK composta |
| `holders` | sim | `crm_clients`, `crm_client_documents` | um documento por Titular; `document_digits` gerado; `client_profile_id` liga a conta do cliente |
| `holder_partnerships` | sim | `crm_client_relations` | `company_id`, `partner_id`, `%`, cargo, `source deps/operator` |
| `dossiers` | sim | `batches`, `company_reports` | `kind PF/PJ/PJ_FULL`, `holder_id` principal, `product`, parecer consolidado |
| `consultations` | sim | — | `holder_id` e `dossier_id` obrigatórios |
| `scr_authorizations` | sim | — | `holder_id` obrigatório |
| `bureau_payloads`, `bureau_results`, `ai_reports` | sim | — | "bureau" aqui é o fornecedor de dados (DEPS); os nomes ficam |
| `timeline_events`, `crm_notes` | sim | — | `entity_type holder/query` |
| `support_sessions` | Bureau alvo | — | sessão de suporte; expiração máxima de 1 hora |
| `audit_logs` | `bureau_id` nulo = plataforma | — | ganha `support_session_id` |
| `settings` | global | — | gravação só pelo superadmin |

**Conta do cliente separada do Titular.** A conta é o `profile` com papel `client` no Bureau. O Titular não guarda login. `holders.client_profile_id` liga o Titular à conta para o portal. Carteira e auto-cadastro chegam no M3/M5.

**Integridade entre tenants.** Toda FK entre tabelas de tenant é composta: `(bureau_id, <fk>) references <pai> (bureau_id, id)`. Uma linha do Bureau A não aponta para uma linha do Bureau B, mesmo com um uuid conhecido.

## Isolamento (RLS)

- `withUserTransaction` define quatro GUCs: `app.user_id`, `app.user_role`, `app.bureau_id`, `app.support_session_id`. Só o servidor define esses valores, a partir de `auth_profile_for_session`.
- `app_is_staff()` é verdadeiro para `bureau_admin` e `operator`. Para o superadmin, só com sessão de suporte ativa.
- `app_support_active()` (SECURITY DEFINER) confere: id do GUC, dono = usuário, Bureau = GUC, `ended_at is null`, `expires_at > now()`.
- Política de tenant: `bureau_id = app_bureau_id() and (select app_is_staff())`. O cliente só lê o próprio Titular.
- Uma identidade sem `bureauId` não lê nenhuma linha de tenant (falha fechada).
- Métricas do superadmin vêm de `platform_bureau_metrics()`: só contagens por Bureau, sem coluna pessoal.

## Papéis e permissões

| Permissão | superadmin | superadmin em suporte | bureau_admin | operator | client |
|---|---|---|---|---|---|
| `bureaus:manage`, `support:enter` | sim | sim | — | — | — |
| `settings:read` | sim | sim | sim | sim | — |
| `settings:write` | sim | sim | — | — | — |
| `holders:*`, `consultations:*`, `reports:*` | — | sim | sim | sim | — |
| `users:manage`, `audit:read` | — | — | sim | — | — |
| `portal:read`, `portal:write` | — | — | sim | — | sim |

`clients:*` vira `holders:*`. O MFA é obrigatório para superadmin, `bureau_admin` e `operator`. Um Bureau inativo bloqueia a sessão dos seus usuários. O superadmin em suporte acessa um Bureau inativo.

## Modo suporte

- O superadmin escolhe o Bureau e informa o motivo. O início encerra qualquer sessão aberta do mesmo superadmin.
- A sessão vale 1 hora. O superadmin encerra antes pelo banner.
- Uma faixa no painel mostra o Bureau e a hora de expiração.
- Toda auditoria gravada em suporte leva `support_session_id` e o `bureau_id` do Bureau alvo.
- O admin do Bureau vê na auditoria as ações marcadas como "Suporte".
- Início e fim são eventos da plataforma (`bureau_id` nulo) com o motivo e o Bureau em `metadata`.

## Convites

- Superadmin: cria o Bureau e convida o primeiro admin na mesma transação.
- `bureau_admin`: convida `bureau_admin` ou `operator` no próprio Bureau. O `bureau_id` vem da sessão, nunca do formulário.
- Mesmo e-mail, mesmo Bureau, mesmo papel e senha ainda não definida: reenvia o convite.
- E-mail com perfil de outro papel ou Bureau: rejeita com "E-mail já em uso".
- Falha no envio depois do commit: o convite fica registrado e a tela oferece "Reenviar".

## Fora do escopo

- Catálogo e preço por Bureau (M2). A página `/b/<slug>` ainda não lista produtos (critério de #21 adiado para o M2).
- Auto-cadastro do cliente (M5). A página só mostra "cadastro em breve".
- Carteira, cobrança e liberação de resultado (M3/M6).
- Subdomínio ou domínio próprio por Bureau.
- Migração de dados: não há dados a preservar; `npm run db:reset` recria o banco de dev.

## Critérios de pronto

Cada critério aponta para o teste que o prova (ver o plano).

- Um operador do Bureau A não lê, cria, altera nem apaga linhas do Bureau B em nenhuma tabela de tenant (Task 1).
- O superadmin sem sessão de suporte ativa vê zero linhas de tenant. Com sessão expirada, encerrada ou de outro Bureau, também (Task 1).
- O mesmo CPF existe em dois Bureaus. O mesmo CPF, com ou sem máscara, falha no mesmo Bureau (Task 1).
- A confirmação pública do SCR grava na timeline o `bureau_id` da autorização (Task 1).
- O superadmin criado na subida tem papel `superadmin` e `bureau_id` nulo (Task 2).
- Um Dossiê PJ completo cria empresa, sócios, sociedades e uma consulta por membro (Task 4).
- "Pesquisas" filtra por PF, PJ e PJ completo sem perder membros (Tasks 4 e 7).
- O superadmin cria, edita e desativa um Bureau e convida o admin (Task 5).
- O admin do Bureau convida, ativa, desativa e muda o papel da equipe (Task 6).
- `/b/<slug>` mostra o nome do Bureau ativo e devolve 404 para inexistente ou inativo (Task 3).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) O convite chega pelo SMTP de produção.
- (post-deploy) As consultas de listagem usam os índices `bureau_id` com volume real.

## Riscos

- Os GUCs são confiáveis só porque apenas o servidor os define. Uma rota que monte a identidade à mão sem `bureauId` falha fechada (zero linhas), não vaza.
- A troca de `DbIdentity` quebra a compilação até a onda 4. Os commits intermediários não passam no `type-check`.
- `bureau_payloads` e `bureau_results` usam "bureau" no sentido de fornecedor (DEPS). Os nomes ficam para não ampliar o diff.
