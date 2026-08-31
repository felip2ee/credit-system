// `settings` key/value store — parameterized SQL under Task 3 transaction/RLS
// boundaries. Reads need admin/consultant, writes need admin (004_rls.sql:
// settings_select / settings_admin_write). No PoolClient escapes this module.

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { writeAuditEvent } from "@/lib/audit/write";

// jsonb comes back already parsed by node-pg.
export async function readSetting(
  identity: DbIdentity,
  key: string,
): Promise<unknown> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ value: unknown }>(
      "select value from settings where key = $1",
      [key],
    );
    return rows[0]?.value ?? null;
  });
}

export async function readSettings(
  identity: DbIdentity,
  keys: string[],
): Promise<Map<string, unknown>> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ key: string; value: unknown }>(
      "select key, value from settings where key = any($1::text[])",
      [keys],
    );
    return new Map(rows.map((r) => [r.key, r.value]));
  });
}

export interface UpsertSettingInput {
  key: string;
  value: unknown;
  description?: string | null;
}

export async function upsertSettings(
  identity: DbIdentity,
  entries: UpsertSettingInput[],
  auditAction: string,
): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    for (const e of entries) {
      await client.query(
        `insert into settings (key, value, description, updated_by, updated_at)
         values ($1, $2::jsonb, $3, $4, now())
         on conflict (key) do update set
           value = excluded.value,
           description = coalesce(excluded.description, settings.description),
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [e.key, JSON.stringify(e.value), e.description ?? null, identity.userId],
      );
    }
    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: auditAction,
      targetTable: "settings",
      metadata: { keys: entries.map((e) => e.key) },
    });
  });
}

export async function deleteSettings(
  identity: DbIdentity,
  keys: string[],
  auditAction: string,
): Promise<void> {
  await withUserTransaction(identity, async (client) => {
    await client.query("delete from settings where key = any($1::text[])", [keys]);
    await writeAuditEvent(client, {
      actorId: identity.userId,
      action: auditAction,
      targetTable: "settings",
      metadata: { keys },
    });
  });
}
