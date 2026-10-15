---
name: feedback-commit-per-task
description: Commit rule — one conventional commit per task, in plan order, with HEAD captured right before each commit
metadata:
  type: feedback
---

Make one commit per task (or per issue), in plan order. Use Conventional Commits (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`). Run `git rev-parse --short HEAD` immediately before each commit and record it. Report the task, the issue and the commit hash in a list when done.

**Why:** the user asked for this pattern on 2026-10-13. In M0, parallel waves produced mixed commits (the Task 2 commit held the Task 3 deletions; the Task 4 commit held the Task 6 Traefik edit). The user wants a clean history that maps one commit to one task.

**How to apply:**
- Stage only the files of the current task (`git add <paths>`). Never use `git add -u .` or `git add -A` across tasks.
- After a parallel wave, commit task by task from the `Files:` list of each task. Resolve a shared file (for example `docker-stack.yml`) with `git add -p`.
- Put `Closes #n` in the commit body of the task's issue.
- Add the `Co-Authored-By` line that the session reminder gives.
- Never rewrite pushed history (force-push) without explicit user confirmation.
