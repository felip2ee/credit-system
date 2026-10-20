# Setup e evidências

Registro da adoção do [vibe-coding-toolkit](https://github.com/soumatheusgomes/vibe-coding-toolkit) neste projeto. Atualize este arquivo a cada nova execução do setup.

## Origem e contexto

- Toolkit: revisão `f13bb354363dafef8ce8d8f605856cc9e1cc52cc` (2026-10-15), clonado em diretório temporário fora do projeto.
- Data da execução: 2026-10-15. Branch: `feature/m4-notificacoes` (HEAD `16089b6` antes do setup).
- Cliente: Claude Code (modelo da sessão principal preservado). Codex não configurado: fora de escopo.
- Fontes lidas: README, `docs/00`–`06`, `docs/tools/01`–`16`, `docs/prompts/12`, `templates/AGENTS.md.template`, `templates/project-docs/manifest.json`, `templates/eslint/`, `templates/hooks/`.

## Decisões e fontes

- Manter ESLint 8 (`.eslintrc.json`, `next lint`). Os módulos `quality/*` do toolkit exigem ESLint 9 flat config. Usamos as regras core `max-lines` e `no-console` em `warn` com baseline. Decisão do usuário em 2026-10-15.
- `AGENTS.md` é a fonte compartilhada. `CLAUDE.md` começa com `@AGENTS.md` e guarda só o específico do Claude Code.
- Regras `.claude/rules/ecc/common/*` e skills fora da stack foram arquivadas em `.claude/archive/`, que não é carregado. Motivo: conflito com Lean delivery e com `05-testing.md`. Ver `.claude/archive/rules/README.md`.
- `app-builder` e `i18n-localization` ficaram em `.claude/skills/`: `.claude/commands/create.md`, `.claude/scripts/verify_all.py` e `clean-code/SKILL.md` ainda os referenciam.
- Skills Vercel: instaladas só as que o projeto usa. `deploy-to-vercel` e `vercel-cli-with-tokens` não se aplicam (deploy em Docker Swarm via GHCR). `web-design-guidelines` já existia.
- Política de delegação: subagentes com o modelo mais leve que cumpre o aceite (`haiku` busca/docs/config; `sonnet` implementação/testes/review; `opus` só planejamento e revisão final de dinheiro/segurança). Ver `AGENTS.md`.
- Nenhum hook Git, proteção de branch, push ou deploy foi adicionado.

## Componentes

| Componente | Ação e motivo | Escopo | Estado e evidência |
|---|---|---|---|
| Superpowers 6.4.1 | Reaproveitado (plugin global ativo). | Global | Validado: `brainstorming` carregou nesta sessão. |
| Ponytail (full) | Reaproveitado. | Global | Validado: hook SessionStart ativo. |
| Caveman (ultracave) | Reaproveitado; só conversa. | Global | Validado: hook SessionStart ativo. |
| RTK 0.52.0 | Reaproveitado via `.claude/hooks/rtk-hook.mjs`. Não rodamos `rtk init --global` (evita wrapper duplicado). | Projeto | Validado: saída com `[+N hidden: rtk recall …]`. |
| Context7 | Reaproveitado via `.mcp.json` (http). O plugin `context7@claude-plugins-official` está duplicado e pede autenticação: desativar é mudança global, não feita. | Projeto | Validado: `resolve-library-id("ESLint")` respondeu. |
| Graphify 0.9.67 | Reaproveitado. `.graphifyignore` completado com `.env`, `.env.*`, `*.key`, `*.p12`, `*.pfx`, `auth.json`, `credentials.json`, `*.log`, `package-lock.json`, `.codex/`, `.vercel/`. Grafo cobre só código (`docs/` e `*.md` excluídos). | Projeto | Configurado. Grafo de 2026-10-15 00:22; nenhum código em `src/` mudou neste setup. |
| Skills Vercel | Instaladas `vercel-react-best-practices`, `vercel-composition-patterns`, `vercel-optimize`, `find-skills` em `.claude/skills/` (cópias; o CLI não criou `.agents/`). `skills-lock.json` atualizado. | Projeto | Validado: `npx --yes skills@latest list --agent claude-code`. |
| agent-browser | Inaplicável: Playwright MCP (`.mcp.json`) cobre automação de browser. | – | – |
| Chrome DevTools MCP | Bloqueado até haver necessidade de diagnóstico de performance. Retomada: `claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest`. | – | – |
| Anthropic skills, aia-harness, hookify, ui-ux-pro-max, code-review, pr-review-toolkit, commit-commands, feature-dev | Reaproveitados (plugins globais). | Global | Validado: listados na sessão. |
| Obsidian, Biome | Inaplicáveis: sem necessidade concreta. | – | – |
| Memória | Reaproveitada: `.claude/memory/` (índice + arquivos) e auto-memory do Claude Code. | Projeto | Configurado. |
| ESLint quality gates | `max-lines` 350 (`warn`, testes/fixtures/e2e isentos) e `no-console` (`warn`, `allow: warn, error`) em `src/`. | Projeto | Validado: `npm run lint` exit 0, 14 warnings. |
| Comandos canônicos | `npm run check` = lint + type-check + test. `engines.node >=22`, `.nvmrc` = `22`. | Projeto | Validado: `npm run check` exit 0. |
| Dependências | `@types/node` `^20` → `^22` (22.20.5); `@types/nodemailer` movido para devDependencies. `npm install` sem flags. | Projeto | Validado: `tsc --noEmit` 0 erros. |
| Docs do manifesto | Criados `PRODUCT.md`, `docs/architecture.md`, `docs/design.md`, `docs/onboarding.md`, `docs/quality.md`, `docs/setup.md`; `README.md` ganhou "Documentação". Removido `docs/harness/strategies.md` (placeholder). | Projeto | Configurado; links conferidos. |
| AGENTS.md / CLAUDE.md | `AGENTS.md` novo (120 linhas). `CLAUDE.md` de ~200 para 100 linhas. | Projeto | Configurado. |
| settings.json | Reformatado (JSON idêntico). Removido `settings.json.graphify-bak` (diferença: só `Read(./.env.*)` genérico, já coberto por regras específicas de `.env.local`, `.env.production` etc.). | Projeto | Validado: hook `validate-settings-schema`. |
| Hooks próprios | Preservados (23 scripts, todos referenciados existem). Nenhum hook novo. | Projeto | Configurado sem execução adicional. |
| CI | Sem alteração: `ci.yml` já roda lint, type-check, vitest, scripts, migração dupla, integração e build. | – | Reaproveitado. |

## Baseline de lint (2026-10-15)

14 warnings, 0 erros. Meta: zerar e promover a `error`, um arquivo por vez (prompt 09 do toolkit).

| Regra | Contagem | Arquivos |
|---|---|---|
| `max-lines` (350, sem brancos/comentários) | 9 | `src/lib/catalog/queries.ts` 520, `src/lib/holders/queries.ts` 456, `src/lib/pdf/consultation-document.tsx` 454, `src/lib/dossiers/queries.ts` 429, `src/lib/pdf/consultation-full-document.tsx` 421, `src/lib/ai/prompt.ts` 412, `src/lib/deps/adapter.ts` 384, `src/test/seed.ts` 384, `src/components/consultations/consultation-form.tsx` 353 |
| `no-console` | 5 | `src/app/api/webhooks/whatsapp/route.ts`, `src/instrumentation.ts`, `src/lib/auth/email.ts`, `src/lib/deps/real.ts:159`, `src/lib/notifications/dispatch.ts:139` |

Contagem bruta (com brancos e comentários): 27 arquivos acima de 350 linhas, 7 acima de 800 (todos `*.integration.test.ts`).

## Verificações

| Item | Antes | Depois | Estado |
|---|---|---|---|
| `npm run lint` | exit 0, 0 warnings | exit 0, 14 warnings (baseline) | Validado |
| `npm run type-check` | exit 0 | exit 0 (com `@types/node` 22) | Validado |
| `npm run test` | 105 arquivos, 1563 testes | 105 arquivos, 1566 testes (contagem varia entre execuções) | Validado (Postgres local ativo) |
| `npm run build` | falha sem env: `TRAEFIK_PROXY_CIDR is required in production` | igual (pré-existente; CI usa placeholders) | Pendente: build local exige env |
| `npm run check` | não existia | exit 0 | Validado |
| `npm audit --omit=dev` | – | 13 (1 crítica `next` Image Optimizer; 9 altas via `tailwindcss` 3 → `braces`/`micromatch`; 3 moderadas) | Relatado; correções exigem majors (`next` 16, `tailwindcss` 4) |
| Context7 | – | consulta real respondida | Validado |
| Harness em sessão limpa | – | `claude -p --model haiku` listou os 9 comandos, apontou `AGENTS.md` como mapa e a skill `postgresql-database-engineering` | Validado |
| Reexecução | – | skills add é idempotente (`skills-lock.json`); sed/JSON das configs preservam conteúdo | Revisão estática |

## Pendências e próxima entrega

- **Audit `npm`:** `next` 14.2 tem advisory crítico no Image Optimizer (`remotePatterns`). A correção exige `next` 16. Proposta separada: migrar Next (major) ou confirmar que `images.remotePatterns` não é usado. `tailwindcss` 4 idem.
- **Build local:** exige env de produção. Próxima ação: documentar um `.env.build.example` ou tornar `TRAEFIK_PROXY_CIDR` opcional fora de produção (decisão de produto/infra).
- **Warnings de lint:** 14 (tabela acima). Reduzir um arquivo por vez, sem subir o teto.
- **Rate limiting:** login tem rate limit (Better Auth). `autorizacao-scr/[token]` não limita tentativas de `auth_code`; webhooks Asaas/WhatsApp e dispatch dependem só de segredo/assinatura. Proposta de domínio, fora deste setup.
- **Plugin Context7 duplicado:** desativar `context7@claude-plugins-official` em `~/.claude/settings.json` (mudança global; aguardando autorização).
- **Skills referenciadas:** `app-builder` e `i18n-localization` ficam até `.claude/commands/create.md` e `.claude/scripts/verify_all.py` serem revistos.
- **Vitest:** `include` cobre `src/**/*.test.ts` e `e2e/**/*.test.ts`; sem `.test.tsx` e sem cobertura mínima. Playwright (`npm run test:e2e`) roda na CI e em `verify:release`.
- **Gatilhos de revisão futura:** nova versão do toolkit; upgrade de `next` ou `eslint`; mudança de hooks em `.claude/settings.json`; adoção de logger (remover `no-console` do baseline).

## Repetir o setup

1. Clone o toolkit em diretório temporário e anote a revisão.
2. Rode `npm run check` e registre o baseline antes de editar.
3. Compare `AGENTS.md` com `templates/AGENTS.md.template` e os 9 docs com `templates/project-docs/manifest.json`. Edite só o que mudou.
4. Atualize skills: `npx --yes skills@latest update --project --yes`.
5. Rode `npm run check` de novo e atualize as tabelas deste arquivo.

## Banco de testes

Os testes de integração usam o banco `credit_system_test`, nunca o `credit_system` de dev. Um volume novo já cria o banco (`docker/postgres/dev-init/003-test-database.sh`). Num volume antigo, crie o banco uma vez:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres sh < docker/postgres/dev-init/003-test-database.sh
npm run db:test:migrate
```

`npm test` roda `db:test:migrate` antes (`pretest`). O guard de `src/test/db-env.ts` recusa nomes sem `_test`; `TEST_DATABASE_ALLOW_ANY_NAME=1` desliga a recusa.
