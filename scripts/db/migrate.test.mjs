import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { loadMigrations, migrate, pendingMigrations } from "./migrate.mjs";

test("rejects a changed checksum for an applied migration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "credit-system-migrations-"));

	try {
		const file = join(directory, "001_example.sql");
		await writeFile(file, "select 1;\n");
		const [applied] = await loadMigrations(directory);
		const history = new Map([[applied.version, applied.checksum]]);

		await writeFile(file, "select 2;\n");
		const [changed] = await loadMigrations(directory);

		assert.throws(
			() => pendingMigrations([changed], history),
			/checksum mismatch for migration 001_example\.sql/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects an applied migration missing from disk", () => {
	assert.throws(
		() => pendingMigrations([], new Map([["001_removed.sql", "a".repeat(64)]])),
		/applied migration 001_removed\.sql is missing from disk/,
	);
});

test("limits profile SELECT policy to self, own-bureau staff and superadmins", async () => {
	const sql = await readFile("db/migrations/004_rls.sql", "utf8");
	const policy = sql.match(
		/create policy profiles_select on profiles for select\s+using \(([\s\S]*?)\);\n\ncreate policy/,
	)?.[1];

	assert.ok(policy, "profiles_select policy not found");
	assert.match(policy, /id = app_user_id\(\)/);
	assert.match(
		policy,
		/bureau_id = app_bureau_id\(\) and \(select app_is_staff\(\)\)/,
	);
	assert.match(
		policy,
		/app_user_role\(\) = 'superadmin' and role = 'superadmin'/,
	);
});

test("restricts the public SCR gateway role to RLS policies and column grants", async () => {
	const sql = await readFile(
		"db/migrations/009_public_scr_gateway_privileges.sql",
		"utf8",
	);

	assert.match(
		sql,
		/alter role auth_profile_lookup NOLOGIN NOINHERIT NOBYPASSRLS;/,
	);
	assert.match(
		sql,
		/revoke all on public\.scr_authorizations from auth_profile_lookup;/,
	);
	assert.match(
		sql,
		/grant update \([\s\S]*auth_code[\s\S]*\) on public\.scr_authorizations to auth_profile_lookup;/,
	);
	assert.match(
		sql,
		/create policy scr_authorizations_gateway_select on public\.scr_authorizations for select to auth_profile_lookup/,
	);
	assert.match(
		sql,
		/create policy timeline_events_gateway_insert on public\.timeline_events for insert to auth_profile_lookup/,
	);
	assert.doesNotMatch(sql, /select \*\s+into v_authorization/);
});

const ADMIN_URL = "postgres://postgres:test@127.0.0.1:54329/postgres";

// Runs `migrate.mjs --check` as a child process and returns its exit code and stderr.
function runCheck(env) {
	return new Promise((resolveRun) => {
		const child = spawn(
			process.execPath,
			["scripts/db/migrate.mjs", "--check"],
			{ env: { PATH: process.env.PATH, ...env } },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolveRun({ code, stderr }));
	});
}

// Each --check test gets its own database so it never races reset.test.mjs.
async function withTempDatabase(fn) {
	const name = `check_probe_${process.pid}_${Date.now()}`;
	const admin = new pg.Client({ connectionString: ADMIN_URL });
	await admin.connect();
	try {
		await admin.query(`create database ${name}`);
		await fn(`postgres://postgres:test@127.0.0.1:54329/${name}`, name);
	} finally {
		await admin.query(`drop database if exists ${name} with (force)`);
		await admin.end();
	}
}

// Fotografia das funções do schema public: definição, dono e grants. O mesmo conjunto em banco novo e em banco já migrado.
async function functionSnapshot(url) {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const { rows } = await client.query(`
			select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as def,
			       p.proowner::regrole::text as owner, coalesce(p.proacl::text, '') as acl
			  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			 where n.nspname = 'public' and p.prokind = 'f'
			 order by 1`);
		return rows;
	} finally {
		await client.end();
	}
}

function migrateUpTo(url, directory) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, ["scripts/db/migrate.mjs"], {
			env: { PATH: process.env.PATH, DATABASE_OWNER_URL: url, MIGRATIONS_DIR: directory },
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => (code === 0 ? resolveRun() : reject(new Error(`migrate exited ${code}: ${stderr}`))));
	});
}

test("apply_asaas_payment (087) is the same on a fresh database and on one migrated to 069 first", async () => {
	const directory = await mkdtemp(join(tmpdir(), "credit-system-upto-069-"));
	try {
		const all = await loadMigrations();
		for (const { version, sql } of all.filter(({ version }) => version.slice(0, 3) <= "069")) {
			await writeFile(join(directory, version), sql);
		}
		let fresh;
		await withTempDatabase(async (freshUrl) => {
			await migrate(freshUrl);
			fresh = await functionSnapshot(freshUrl);
		});
		await withTempDatabase(async (stagedUrl) => {
			await migrateUpTo(stagedUrl, directory);
			await migrate(stagedUrl);
			const staged = await functionSnapshot(stagedUrl);
			assert.deepEqual(staged, fresh);
			const fn = staged.find((f) => f.signature.startsWith("apply_asaas_payment("));
			assert.ok(fn, "apply_asaas_payment not found");
			// Os dois corpos juntos: Pix de pedido (065-067) e cash-in, split e reversão (075-082).
			for (const part of ["apply_order_pix_charge", "cancel_order_after_pix_refund", "record_cash_in_commission", "reverse_cash_in_commission", "apply_payment_link_charge"]) {
				assert.match(fn.def, new RegExp(part));
			}
			assert.match(fn.def, /v_result in \('order_paid', 'order_reserve_failed', 'order_not_payable'\)/);
			assert.equal(fn.owner, "auth_profile_lookup");
			assert.equal(fn.acl, "{auth_profile_lookup=X/auth_profile_lookup,app_webhook=X/auth_profile_lookup}");
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("--check exits 0 when current", async () => {
	await withTempDatabase(async (ownerUrl) => {
		await migrate(ownerUrl);
		const { code } = await runCheck({ DATABASE_URL: ownerUrl });
		assert.equal(code, 0);
	});
});

test("--check exits 2 when a migration is pending", async () => {
	await withTempDatabase(async (ownerUrl) => {
		await migrate(ownerUrl);
		const directory = await mkdtemp(join(tmpdir(), "credit-system-check-"));
		try {
			await cp("db/migrations", directory, { recursive: true });
			await writeFile(join(directory, "999_check_probe.sql"), "select 1;\n");
			const { code, stderr } = await runCheck({
				DATABASE_URL: ownerUrl,
				MIGRATIONS_DIR: directory,
			});
			assert.equal(code, 2);
			assert.match(stderr, /schema has 1 pending migration\(s\)/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

test("--check runs as app_runtime after grant", async () => {
	await withTempDatabase(async (ownerUrl, name) => {
		await migrate(ownerUrl);
		const { code } = await runCheck({
			DATABASE_URL: `postgres://app_runtime:test@127.0.0.1:54329/${name}`,
		});
		assert.equal(code, 0);
	});
});

test("--check exits 1 when schema_migrations does not exist", async () => {
	await withTempDatabase(async (ownerUrl) => {
		const { code } = await runCheck({ DATABASE_URL: ownerUrl });
		assert.equal(code, 1);
	});
});

test("--check falls back to DATABASE_OWNER_URL when DATABASE_URL is empty", async () => {
	await withTempDatabase(async (ownerUrl) => {
		await migrate(ownerUrl);
		const { code } = await runCheck({
			DATABASE_URL: "",
			DATABASE_OWNER_URL: ownerUrl,
		});
		assert.equal(code, 0);
	});
});

test("entrypoint retries --check until exit 0", async () => {
	const directory = await mkdtemp(join(tmpdir(), "credit-system-entrypoint-"));
	try {
		const counter = join(directory, "count");
		await writeFile(counter, "0");
		await writeFile(
			join(directory, "node"),
			`#!/bin/sh
if [ "$1" = "server.js" ]; then echo "server started"; exit 0; fi
n=$(cat "${counter}"); n=$((n + 1)); echo "$n" > "${counter}"
[ "$n" -ge 3 ] && exit 0
exit 2
`,
			{ mode: 0o755 },
		);
		await writeFile(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		const { code, out } = await new Promise((resolveRun) => {
			const child = spawn("sh", ["docker/app-entrypoint.sh"], {
				env: { PATH: `${directory}:${process.env.PATH}`, MIGRATE_MAX_ATTEMPTS: "5" },
			});
			let out = "";
			child.stdout.on("data", (chunk) => (out += chunk));
			child.on("close", (code) => resolveRun({ code, out }));
		});
		assert.equal(code, 0);
		assert.match(out, /server started/);
		assert.equal((await readFile(counter, "utf8")).trim(), "3");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("entrypoint gives up after MIGRATE_MAX_ATTEMPTS", async () => {
	const directory = await mkdtemp(join(tmpdir(), "credit-system-entrypoint-"));
	try {
		await writeFile(join(directory, "node"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
		await writeFile(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const { code, err } = await new Promise((resolveRun) => {
			const child = spawn("sh", ["docker/app-entrypoint.sh"], {
				env: { PATH: `${directory}:${process.env.PATH}`, MIGRATE_MAX_ATTEMPTS: "2" },
			});
			let err = "";
			child.stderr.on("data", (chunk) => (err += chunk));
			child.on("close", (code) => resolveRun({ code, err }));
		});
		assert.equal(code, 1);
		assert.match(err, /schema is not current after 2 attempts/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
