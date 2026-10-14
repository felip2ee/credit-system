import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMigrations, pendingMigrations } from "./migrate.mjs";

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

test("limits profile SELECT policy to self, own-bureau staff and superadmin admins", async () => {
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
		/app_user_role\(\) = 'superadmin' and role in \('superadmin', 'bureau_admin'\)/,
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
