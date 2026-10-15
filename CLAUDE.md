@AGENTS.md

# credit-system — Claude Code

> Keep this file short and high-signal. Bloated memory gets ignored. Put hard guarantees in hooks, not prose.
> Shared rules are in `AGENTS.md`. This file has only Claude Code specifics.

@.claude/memory/INSTRUCTIONS.md
@.claude/memory/MEMORY.md

## Main session = orchestrator
- The main session plans, decides and coordinates. It does not implement.
- Send all delegable implementation and analysis to a specialist subagent through `Agent`. Run them in parallel when scopes do not conflict.

## Lean delivery
Applies to every plan (`superpowers:writing-plans`, `/plan`, planner agents) and every execution (`superpowers:subagent-driven-development`, `/orchestrate`). On conflict with a skill, rule or agent description, this section wins.

- **A plan specifies; it does not implement.** Per task: `Files:`, `Depends-on:`, the contract or signature, the rules that apply (by name), and the test cases. Write code only where the exact form is the requirement (money math, API contract, migration, locking query).
- **A task is a cohesive slice for one specialist, with its own tests.** No micro-tasks. At most 8 tasks. An acceptance criterion is not a task: point to the test that proves it.
- **Keep out of the plan:** review tasks, final-gate tasks, criteria-matrix tasks, a separate "validate data" task, scenario simulation in rounds, repeated dry-runs, waits of hours or days, manual user actions. Simulate only a critical money or security scenario that no test covers: one run, inside its task.
- **What only production can confirm** is a criterion marked `(post-deploy)`. It becomes one "Post-deploy follow-up" item in the PR body. It never blocks the merge or the issue closing. The PR keeps `Closes #n`.
- **Review once per finished issue or sub-issue:** `/code-review` and the normal PR loop. Never per task, wave or plan phase. No per-task reviewer, no fix-and-re-review rounds, no separate final review from the execution skill.
- **Task gate:** its scoped tests pass. If they fail, the same specialist fixes them (2 attempts at most), then escalate. Fix P0/P1 findings directly. Minor findings follow the review flow's own severity cut.
- **Implementers** are the project's specialist agents with an explicit `model`: `sonnet`, or `haiku` for docs, config and mechanical edits with a complete spec. Never `opus`.
- **Docs and config have no plan.** Dispatch directly to a Haiku or Sonnet agent.
- **Status to the user:** 1 line per milestone, not per task.

## Workflow & Agents
Invoke `superpowers:subagent-driven-development` for non-trivial implementation. Trigger it when the request meets 2 or more of:
- touches 3+ files or 2+ domains/layers
- is a new feature, epic or cross-cutting refactor
- needs a multi-step plan with ordered tasks
- has unclear scope or root cause and needs exploration first

Skip it for typo/copy fixes, single-function edits, config tweaks and one-file bugs with an obvious cause. Implement those inline.

Dispatch the matching specialist as `subagent_type`. Never use `general-purpose` when a specialist covers the domain. Pass `model` on every dispatch, at the cheapest tier that fits. A PreToolUse hook sets `sonnet` when no model is given. Plugin agents (`plugin:name`) are not rewritten.

| Agent | Use for |
|---|---|
| `orchestrator` | Multi-agent or cross-domain tasks. |
| `code-reviewer` | Review of code changes. |
| `security-reviewer` | OWASP, secrets, auth, CVEs. |
| `security-auditor` | Defensive SAST, threat model. |
| `penetration-tester` | Offensive security, pentest. |
| `test-engineer` | Unit and integration tests. |
| `qa-automation-engineer` | E2E tests and CI quality gates. |
| `database-architect` | Schema, migrations, queries, indexes. |
| `backend-specialist` | API, server logic, auth, persistence. |
| `frontend-specialist` | UI components, layout, styling. |
| `devops-engineer` | Deploy, CI/CD, infra. |
| `performance-optimizer` | Profiling and bottlenecks. |
| `seo-specialist` | Metadata and crawlability of public pages. |
| `project-planner` | Epics into ordered tasks with acceptance criteria. |
| `product-manager` | Ambiguous requirements, prioritization. |
| `product-owner` | Acceptance criteria for existing stories. |
| `code-archaeologist` | Understand legacy code before a change. |
| `debugger` | Root cause of bugs and flaky tests. |
| `explorer-agent` | Map an unfamiliar codebase. |
| `documentation-writer` | Docs, only when explicitly requested. |

### Superpowers to specialists
Superpowers examples use `general-purpose`. Dispatch the specialist instead (CLAUDE.md has the highest priority). The flow stays `brainstorming` → `writing-plans` → `subagent-driven-development`.

| Superpowers would use `general-purpose` for | Dispatch |
|---|---|
| Multi-domain feature | `orchestrator` |
| Review or audit | `code-reviewer` / `security-reviewer` |
| E2E / QA | `qa-automation-engineer` |
| Unit / integration tests | `test-engineer` |
| Schema / migration / query | `database-architect` |
| Deploy / CI/CD / infra | `devops-engineer` |
| Backend / API / domain logic | `backend-specialist` |
| UI / components / pages | `frontend-specialist` |
| Performance | `performance-optimizer` |
| Legacy code | `code-archaeologist` |
| Bug / crash | `debugger` |
| Explore codebase | `explorer-agent` |
| Docs (explicit request only) | `documentation-writer` |
| Pentest / security audit | `penetration-tester` / `security-auditor` |

### Parallel waves
Run independent tasks in parallel waves. Tag each task `Files:` and `Depends-on:`. Batch tasks with disjoint files and no dependency into one wave. Dispatch the wave in one message. Implementers do not self-commit; the coordinator commits. Untagged or uncertain tasks run serial. Full protocol: `.claude/rules/08-parallel-subagent-driven-development.md`.

## Skills for this stack
Invoke the skill before you work in its domain.
- Next.js: `/vercel:nextjs`
- UI/UX: `/ui-ux-pro-max`
- shadcn/ui: `/vercel:shadcn`
- PostgreSQL: `/postgresql-database-engineering`

## Graphify
When `graphify-out/graph.json` exists, run `graphify query "<question>"` first for codebase questions. Use `graphify path "<A>" "<B>"` and `graphify explain "<concept>"` for focused questions. Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review. If `graphify-out/wiki/index.md` exists, use it to navigate. After you change code, run `graphify update .`.

## Code review
Use `code-reviewer` and `security-reviewer` together. Apply the `uncle-bob-craft` criteria (Dependency Rule, SOLID in context, code smells).

## Rules
- Fix every compile, syntax or lint error you find in a session, also in files you did not edit. Never label an error "pre-existing".
- Rules in `.claude/rules/` load recursively. Archived rules and skills live in `.claude/archive/` and do not load.
