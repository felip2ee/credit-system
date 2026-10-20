# Qualidade

## Comandos

| Comando | O que prova |
|---|---|
| `npm run lint` | ESLint (`next/core-web-vitals`, `next/typescript`). |
| `npm run type-check` | `tsc --noEmit`. |
| `npm run test` | Vitest: todos os `src/**/*.test.ts`, incluindo integração (exige Postgres). |
| `npm run build` | Build de produção do Next. Exige variáveis de ambiente (veja [onboarding.md](onboarding.md)). |
| `npm run check` | Composto: lint, type-check e test. |
| `npm run db:migrate:test` | `node --test` do runner de migrations e do reset. |
| `npm run setup:test` | `unittest` do `setup_production.py`. |
| `npm run ops:test` | `node --test` do cron de notificações. Roda `docker/backup/backup.test.sh` se `restic` estiver instalado. |
| `npm run test:e2e` | Playwright em `e2e/`: login com MFA, compra no portal e balcão até `ready`. Exige app e banco com seed. |
| `npm run verify:release` | Gate de release: lint, type-check, Vitest, `node --test`, `unittest`, Playwright, build, `docker compose config`, migration duas vezes, suítes com Postgres. Para na primeira falha. |

Quando rodar:

- Durante o trabalho: um teste escopado, por exemplo `npx vitest run src/lib/wallet`.
- Antes de concluir: `npm run lint` e `npm run type-check`, mais os testes do que mudou.
- Antes de abrir o PR: `npm run check`.
- A CI roda lint, type-check, unitários, scripts, migration duas vezes, integração e build. Veja [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Regras de base

- TypeScript strict e presets oficiais do Next (`next/core-web-vitals`, `next/typescript`).
- Teto de 350 linhas por arquivo, como referência. A regra ESLint `max-lines` fica em `warn`, com baseline. Testes são isentos. Baseline: ver [setup.md](setup.md).
- Sem logger no projeto. A regra `no-console` fica em `warn` em `src/`. Baseline: ver [setup.md](setup.md). Não registre segredo, CPF ou CNPJ completo em log.
- Dados não são acessados pela apresentação. Componentes chamam Server Actions; SQL fica em `src/lib/<domínio>/queries.ts`.
- Entradas de Server Actions passam por zod `safeParse` antes de qualquer outra ação.
- SQL é parametrizado e roda dentro de `withUserTransaction`. Nunca concatene valores no SQL.
- Mutação grava evento de auditoria na mesma transação.
- Erros não expõem segredos.
- Tabela nova exige política RLS e um caso em `rls.integration.test.ts`.

## Estratégia de testes

- **Unitários:** Vitest, colocados ao lado do código (`src/**/*.test.ts`). Cobrem regras de negócio, ramificações, dinheiro, segurança e regressões.
- **Integração:** `*.integration.test.ts`, com Postgres real. Em dev: `127.0.0.1:54329`. Banco dedicado `credit_system_test` (nunca o `credit_system` de dev; o guard recusa nomes sem `_test`; `npm test` migra antes via `pretest`). Roles: `app_runtime` (`TEST_DATABASE_URL`) e dono (`TEST_DATABASE_OWNER_URL`). Algumas suítes que disputam o mesmo lock rodam em série.
- **Scripts:** `node --test` (migrate, reset, cron de notificações) e `python -m unittest` (setup de produção).
- **E2E:** Playwright em `e2e/`: `login`, `portal-order`, `counter-order` e `auth`. `npm run test:e2e` sobe o app pelo `webServer` e semeia o banco (`e2e/global-setup.ts`). A CI roda depois de `npm run db:reset`. Os fluxos param em `ready`: o e2e não chama a DEPS nem a OpenAI (D8 do spec do M7). A execução da consulta fica nos testes de integração, com cliente falso.
- Teste componentes só para renderização condicional, validação de formulário, estado ou acessibilidade. UI apenas visual não recebe teste.
- Não escreva teste que repete o código. Não afirme cobertura que não foi medida.

## Revisão após implementação ou correção

Ao concluir um ciclo de implementação ou correção, sugira de 3 a 8 ciclos posteriores de code review, com quantidade proporcional ao risco, focos complementares e prompt de continuação preenchido. Essa faixa é convenção do projeto; revisões adicionais dependem de pedido do usuário.

Cada ciclo verifica o estado atual e o código conectado, registra achados com severidade, local e evidência e reavalia correções autorizadas com os checks afetados. Correções da mesma rodada não reiniciam a contagem. Termine com verificação integrada e riscos residuais, sem criar ciclos artificiais ou afirmar que uma quantidade de revisões prova ausência de bugs.

## Dependências e entrega

Confira auditorias completas e de produção. Investigue advisories e registre risco conhecido e correção disponível. Lint/build aprovados não significam auditoria zerada.

Checks são comandos explícitos. Este projeto não usa hooks Git, bloqueios de push nem exigências de branch como parte do padrão. Atualize este documento junto dos scripts e regras que mudarem.

## Baseline e dívidas conhecidas

- 27 arquivos passam de 350 linhas. 7 passam de 800. Os 7 são `*.integration.test.ts`: rls, settlement, wallet, payouts, notifications, client-wallet e pix-charges.
- O maior arquivo que não é teste é `src/lib/catalog/queries.ts`, com 560 linhas.
- O Vitest inclui só `.test.ts`. Arquivos `.test.tsx` não rodam.
- Não há cobertura mínima configurada.
- O build local exige variáveis de ambiente de produção.
- Não há logger estruturado. O código usa `console` direto.
