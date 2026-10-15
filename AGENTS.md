# credit-system

> Shared instructions for all coding agents. Keep this file short. Client-specific rules go in `CLAUDE.md`.

## Product and stack

- Product and scope: `PRODUCT.md`.
- Stack: Next.js 14.2 (App Router), React, TypeScript, shadcn/ui, `pg` (PostgreSQL, no ORM), npm.
- Architecture and structure: `docs/architecture.md`. Setup and checks: `docs/setup.md`.
- Write all text in Simplified Technical English (ASD-STE100), also in Portuguese. Lead with the result.

## Canonical commands

Use these exact commands. Do not invent scripts.

- Install: `npm install`
- Dev: `npm run dev`
- Lint: `npm run lint` (local rules `max-lines` and `no-console` are warnings)
- Types: `npm run type-check`
- Tests: `npm run test` (integration tests need Postgres at `127.0.0.1:54329`, started with `docker-compose.dev.yml`)
- Build: `npm run build` (needs production env; CI uses placeholders)
- Check all: `npm run check` (lint + type-check + test)
- DB migrate: `npm run db:migrate`
- Release gate: `npm run verify:release`

## Working agreements

- Read the code and instructions that apply before you edit. State assumptions that change behavior or scope.
- If several readings of a request exist, present them. If something is unclear, ask.
- Make the smallest change that completes the request. Reuse existing patterns, components and dependencies.
- Touch only what the request needs. Match the existing style. Do not refactor or reformat adjacent code.
- Remove orphans that your change created. Mention pre-existing dead code. Do not delete it.
- Keep validation, error handling, security, accessibility and explicit requirements.
- Do not add abstractions, options, dependencies or features that nobody asked for.
- Turn a task into a verifiable goal. For a bug, write a test that fails, then make it pass.
- Run the applicable checks. Test business rules, branching logic, money, security, auth and regressions. Do not test trivial code.
- Do not present a hypothesis as a fact. Do not present a pending integration as a simulated result.
- Continue work that is authorized. Ask only for information you need or for an action outside the authorization.
- Publishing, messages to third parties, costs and destructive actions need authorization. Installing a tool does not give it.

## Execution continuity

- During authorized work, answer status questions and resume the remaining actions. Stop if the user pauses, cancels or changes the goal. With no work in progress, an information request ends with the answer.
- A blocker stops only the dependent tasks. Finish the independent tasks that are safe and authorized. Before you stop, check for remaining executable actions in scope.
- If an agent fails or its state is unclear, confirm that it stopped before you take its files. Inspect partial changes. Resume from the verified point. Never use concurrent writers.
- Do not repeat an identical attempt without new evidence. Respect limits on cost, time and attempts, explicit gates and refusals. Earlier decisions do not widen the authorization.
- When you resume from a handoff, check the real files, Git, checks and processes. Claim background work only if an active process, agent or automation exists and you can verify it.
- If no safe option exists, report the blocker, the completed work and what is missing. Do not present a pending item as a result. Do not promise an automatic continuation.

## Patterns and documentation

- Data access: raw SQL through the shared `pg` Pool. No ORM. Run each query in `withUserTransaction({ userId, role }, fn)` (sets the RLS context). Never let a `PoolClient` leave a queries module.
- Validate input with zod (`src/lib/validators/`). Use parameterized SQL only.
- Write an audit event in the same transaction as each mutation. Never store a full CPF/CNPJ.
- Migrations: `db/migrations/NNN_snake_case.sql`. Never edit an applied migration. Never reintroduce Supabase.
- Log with `console`. The project has no logger. Do not log secrets or full request bodies.
- UI strings, errors and comments are in pt-BR.
- Document map. Update the owning document together with the change. Do not duplicate rules.
  - `PRODUCT.md`: product and scope.
  - `docs/architecture.md`: structure and decisions.
  - `docs/design.md`: interface.
  - `docs/onboarding.md`: preparation.
  - `docs/quality.md`: checks.
  - `docs/setup.md`: setup and tool versions.
  - `docs/operations/`: runbooks (NFS-e, notifications, security checklist).
  - `docs/superpowers/{specs,plans}/`: designs and plans.

## Tools and style

- **Ponytail:** `full` level for code. `stop ponytail` turns it off.
- **Caveman:** `ultracave` in the conversation only. Code, docs and commits use normal wording. `stop caveman` turns it off.
- **Superpowers:** use the skills that apply. Scale the flow to the scope. Explicit instructions win over repeated approvals.
- **Context7:** configured in `.mcp.json`. Use it for library and API docs. Query one concept at a time. Never send secrets or private code.
- **RTK:** the hook `.claude/hooks/rtk-hook.mjs` is active. Do not add a second wrapper. Use `rtk proxy <command>` for the original output.
- **Graphify:** use `graphify query`, `graphify path` and `graphify explain` for structure questions. Run `graphify update .` after you change code.
- **Playwright MCP:** use it for browser checks.
- **Models:** a subagent uses the lightest model that meets the acceptance criteria.
  - `haiku`: search, docs, mechanical config.
  - `sonnet`: implementation, tests, review.
  - `opus`: planning and final review of money or security. Never as implementer.
- Do not change provider, proxy or billing mode.

## Skills

Installed skills that apply. Installing a skill does not run its actions.

- `vercel-react-best-practices`: write or review React/Next code, data and performance.
- `vercel-composition-patterns`: component composition and API design.
- `vercel-optimize`: optimization with Vercel metrics.
- `find-skills`: find a skill when a concrete capability is missing.
- `ui-ux-pro-max`: component design, accessibility, UX.
- `vercel:nextjs`: routing, SSR/SSG, cache, middleware.
- `vercel:shadcn`: components and themes.
- `postgresql-database-engineering`: migrations, queries, indexes.
- `uncle-bob-craft`: Dependency Rule, SOLID in context, code smells.

## Git and collaboration

- Use conventional commits: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- Do not add push blocks on `main`, worktree requirements, or `pre-commit`/`pre-push` hooks.
- Commit only when the user asks. Do not push, publish or deploy without authorization.

## Delegation and review

- Delegate only when context isolation, specialization or independent parallel work is worth the coordination cost. Prefer direct work or a deterministic tool for simple tasks.
- Give each task: goal, minimal context, allowed files, dependencies, acceptance criteria and checks.
- One writer per file. The coordinator owns lockfiles, shared config, integration and commits. Reviewers are read-only.
- Check the diff and the checks before you accept a worker result. On failure, find the cause. Escalate capability or context if needed. Respect the attempt limits.
- Review once per finished issue: `/code-review`, `code-reviewer` and `security-reviewer`. Do not review per task or per wave.
- After each implementation or fix cycle, suggest 3 to 8 further code review cycles. Pick the number and focus areas from the risk and scope. Give the reason and a copyable prompt with the number, focus areas and real checks. A suggestion does not authorize running them.
- In an authorized round, each cycle reviews the current state and records findings with severity, location and evidence. Inner fixes do not reset the count. Report residual risks.

## Conventions and context

- Import with `@/` (= `src/`). Identifiers are in English.
- Tests: `src/**/*.test.ts` next to the code. `*.integration.test.ts` uses a real Postgres. Script tests use `node --test`. E2E tests are in `e2e/`.
- Server Actions: zod `safeParse`, then session and `hasPermission(role, "<resource>:<verb>")`, then query, then `revalidatePath`. Return `{ error: string | null, id? }`.
- Queries return `{ ok: false, reason }` for business conflicts. Other errors throw and roll back.
- Return new objects. Do not mutate inputs. Use early returns over deep nesting. Name constants for meaningful limits.
- DB roles: the app uses `DATABASE_URL`. Migrations and `npm run db:reset` use `DATABASE_OWNER_URL`.
