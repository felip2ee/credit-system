#!/usr/bin/env node
// Single release gate. Runs every check IN ORDER, STOPS ON FIRST FAILURE,
// prints per-step duration and a final summary.
//
//   node scripts/verify-release.mjs                  # fail-closed (cutover gate)
//   node scripts/verify-release.mjs --allow-deferred # infra-gated steps -> WARN
//   VERIFY_RELEASE_ALLOW_DEFERRED=1 node scripts/verify-release.mjs
//
// Fail-closed by default: a missing Docker daemon / unreachable Postgres / an
// absent production env is a hard FAIL. `--allow-deferred` downgrades ONLY the
// steps marked `deferred` (the ones that genuinely need real cutover infra) to a
// logged WARN. The cutover runbook REQUIRES one green FLAGLESS run on the real
// target infrastructure before cutover authorization.

import { spawnSync } from "node:child_process";

const allowDeferred =
  process.argv.includes("--allow-deferred") ||
  process.env.VERIFY_RELEASE_ALLOW_DEFERRED === "1";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// Fake values so `docker compose config` can validate the compose file's shape
// without the real release digests. Structural check only — never deployed.
const FAKE_COMPOSE_ENV = {
  REINO_IMAGE_OWNER: "verify",
  REINO_IMAGE_DIGEST: "0".repeat(64),
  REINO_BACKUP_DIGEST: "0".repeat(64),
  APP_DOMAIN: "verify.invalid",
  TRAEFIK_PROXY_CIDR: "10.0.0.0/24",
  SMTP_HOST: "smtp.invalid",
  SMTP_USER: "verify",
  SMTP_FROM: "verify@verify.invalid",
  DEPS_API_EMAIL: "verify@verify.invalid",
  RESTIC_REPOSITORY: "s3:https://s3.invalid/verify",
  BACKUP_ALERT_TO: "verify@verify.invalid",
};

// deferred:true => needs real cutover infra (Docker daemon / target Postgres /
//                  full production env / a completed export dir). WARN under
//                  --allow-deferred, hard FAIL without it.
const GATES = [
  { name: "1. lint", cmd: [npm, "run", "lint"] },
  { name: "2. type-check", cmd: [npm, "run", "type-check"] },
  {
    name: "3. unit + integration vitest (no live-PG suites)",
    cmd: [npx, "vitest", "run", "--exclude", "**/*.integration.test.ts"],
  },
  {
    name: "4. node:test (migration / no-supabase / migrate)",
    cmd: [
      "node",
      "--test",
      "scripts/migration/migration.test.mjs",
      "scripts/check-no-supabase.test.mjs",
      "scripts/db/migrate.test.mjs",
    ],
  },
  {
    name: "5. Playwright auth + consultation + document smoke",
    cmd: [npx, "playwright", "test", "--config", "playwright.config.ts"],
    deferred: true,
  },
  { name: "6. production build", cmd: [npm, "run", "build"], deferred: true },
  {
    name: "7. no-Supabase static check",
    cmd: ["node", "scripts/check-no-supabase.mjs"],
  },
  {
    name: "8. migration checksum check",
    cmd: ["node", "--test", "scripts/db/migrate.test.mjs"],
  },
  {
    name: "9. docker compose config",
    cmd: ["docker", "compose", "-f", "docker-stack.yml", "config"],
    env: FAKE_COMPOSE_ENV,
    deferred: true,
  },
  {
    name: "10. clean-schema migration x2 (2nd = no-op)",
    cmd: ["node", "scripts/db/migrate.mjs"],
    repeat: 2,
    deferred: true,
  },
  {
    name: "11. migration:verify",
    cmd: [npm, "run", "migration:verify"],
    deferred: true,
  },
  {
    name: "12. live-PG integration suites",
    cmd: [npx, "vitest", "run", "integration.test"],
    deferred: true,
  },
];

const results = [];
let hardFailure = false;

for (const gate of GATES) {
  const started = Date.now();
  const runs = gate.repeat || 1;
  process.stdout.write(`\n=== ${gate.name} ===\n${gate.cmd.join(" ")}${runs > 1 ? `  (x${runs})` : ""}\n`);

  let r;
  for (let i = 0; i < runs; i++) {
    r = spawnSync(gate.cmd[0], gate.cmd.slice(1), {
      stdio: "inherit",
      // Windows: .cmd shims (npm/npx) require a shell to be invokable.
      shell: process.platform === "win32",
      env: gate.env ? { ...process.env, ...gate.env } : process.env,
    });
    if (r.status !== 0 || r.error) break;
  }

  const ms = Date.now() - started;
  const ok = r.status === 0 && !r.error;

  let status;
  if (ok) {
    status = "PASS";
  } else if (gate.deferred && allowDeferred) {
    status = "WARN";
    console.warn(
      `WARN: ${gate.name} did not pass (exit ${r.status}${r.error ? `, ${r.error.code}` : ""}). ` +
        `Deferred by --allow-deferred: operator MUST run this at cutover on real infra.`,
    );
  } else {
    status = "FAIL";
    hardFailure = true;
  }

  results.push({ name: gate.name, status, ms });
  if (status === "FAIL") {
    console.error(`\nFAIL: ${gate.name} (exit ${r.status}${r.error ? `, ${r.error.code}` : ""}). Stopping.`);
    break;
  }
}

console.log("\n================ verify:release summary ================");
for (const x of results) {
  console.log(`  ${x.status.padEnd(4)}  ${String(x.ms).padStart(7)}ms  ${x.name}`);
}
const notReached = GATES.length - results.length;
if (notReached > 0) console.log(`  ${notReached} gate(s) not reached (stopped on failure).`);
const warns = results.filter((x) => x.status === "WARN").length;
console.log("=======================================================");

if (hardFailure) {
  console.error("\nverify:release: FAILED");
  process.exit(1);
}
if (warns > 0) {
  console.warn(
    `\nverify:release: PASSED WITH ${warns} DEFERRED WARN(S). ` +
      `NOT a valid cutover gate — the cutover runbook requires a green FLAGLESS run of ` +
      `\`node scripts/verify-release.mjs\` on the real target infrastructure.`,
  );
  process.exit(0);
}
console.log("\nverify:release: PASSED (flagless) — release gate green.");
process.exit(0);
