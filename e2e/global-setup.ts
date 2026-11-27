import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { Pool, type PoolClient } from "pg";

import {
  setPlatformSale,
  seedClientWalletTopup,
  seedWalletTopup,
} from "../src/test/seed";
import { assertE2eDatabase, AUTH_DIR, DATABASE_OWNER_URL, E2E, E2E_AFFILIATE_PCT } from "./fixtures";

type Fk = { child: string; childCols: string[]; parentCols: string[] };

// Foreign keys that point at `parent`, with column names, so children can be deleted before parents.
async function referencing(client: PoolClient, parent: string): Promise<Fk[]> {
  const { rows } = await client.query<{ child: string; child_cols: string[]; parent_cols: string[] }>(
    `select c.conrelid::regclass::text as child,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
       from pg_constraint c
      where c.contype = 'f' and c.confrelid = $1::regclass and c.conrelid <> c.confrelid`,
    [parent],
  );
  return rows.map((r) => ({ child: r.child, childCols: r.child_cols, parentCols: r.parent_cols }));
}

// Deletes the rows matched by `where` in `table` and, first, every row that references them (recursively).
// Runs with triggers off (replica role): append-only guards and FK checks must not block the cleanup.
async function deleteTree(client: PoolClient, table: string, where: string, seen: string[] = []) {
  if (seen.includes(table)) return;
  for (const fk of await referencing(client, table)) {
    const cols = fk.childCols.map((c) => `"${c}"`).join(", ");
    const parentCols = fk.parentCols.map((c) => `"${c}"`).join(", ");
    await deleteTree(client, fk.child, `(${cols}) in (select ${parentCols} from ${table} where ${where})`, [...seen, table]);
  }
  await client.query(`delete from ${table} where ${where}`);
}

async function cleanup(client: PoolClient) {
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  await deleteTree(client, "bureaus", "slug like 'e2e-%'");
  await deleteTree(client, '"user"', "email like 'e2e-%'");
  await client.query("commit");
}

async function insertUser(client: PoolClient, input: { email: string; password: string; name: string; role: string; bureauId: string | null }) {
  const id = randomUUID();
  await client.query('insert into "user" (id, name, email) values ($1, $2, $3)', [id, input.name, input.email]);
  await client.query(
    "insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at) values ($1, 'local:credential', $2, 'credential', $2, $3, now())",
    [randomUUID(), id, await hashPassword(input.password)],
  );
  await client.query(
    "insert into profiles (id, auth_user_id, full_name, email, role, bureau_id) values ($1::uuid, $1::text, $2, $3, $4::user_role, $5)",
    [id, input.name, input.email, input.role, input.bureauId],
  );
  return id;
}

export default async function globalSetup() {
  assertE2eDatabase(DATABASE_OWNER_URL);
  mkdirSync(AUTH_DIR, { recursive: true });
  const owner = new Pool({ connectionString: DATABASE_OWNER_URL, max: 2 });
  const client = await owner.connect();
  try {
    await cleanup(client);

    await client.query("begin");
    const bureau = await client.query<{ id: string }>("insert into bureaus (name, slug) values ('e2e Bureau', $1) returning id", [E2E.bureauSlug]);
    const bureauId = bureau.rows[0].id;
    const staffId = await insertUser(client, { ...E2E.staff, name: "e2e Operador", role: "operator", bureauId });
    await insertUser(client, { ...E2E.superadmin, name: "e2e Superadmin", role: "superadmin", bureauId: null });
    const disabledId = await insertUser(client, { ...E2E.disabled, name: "e2e Desativado", role: "operator", bureauId });
    const clientId = await insertUser(client, { ...E2E.client, name: "e2e Cliente", role: "client", bureauId });
    await client.query(
      `insert into holders (bureau_id, type, name, document, email, phone, client_profile_id, created_by)
       values ($1, 'PF', 'e2e Cliente', $2, $3, $4, $5, $5)`,
      [bureauId, E2E.client.cpf, E2E.client.email, E2E.client.phone, clientId],
    );
    await client.query(
      `insert into legal_acceptances (profile_id, document_id)
       select $1, d.id from (select distinct on (kind) id from legal_documents where published_at <= now() order by kind, version desc) d`,
      [clientId],
    );
    // Phone fields change only through account functions; the e2e run confirms the phone directly.
    await client.query("set local session_replication_role = replica");
    await client.query("update profiles set phone_e164 = $2, phone_verified_at = now() where id = $1", [clientId, E2E.client.phone]);
    await client.query("update profiles set is_active = false where id = $1", [disabledId]);
    // The affiliate section is off by default (075); the affiliate e2e tests need it on.
    await client.query(
      "insert into bureau_affiliate_settings (bureau_id, default_pct, affiliate_enabled, updated_by) values ($1, $2, true, $3)",
      [bureauId, E2E_AFFILIATE_PCT, staffId],
    );
    await client.query("commit");

    const product = await client.query<{ id: string }>("select id from products where code = $1", [E2E.product]);
    const productId = product.rows[0].id;
    // The catalog seeds the products inactive: the superadmin activates them before a Bureau can sell them.
    await owner.query("update products set active = true where id = $1", [productId]);
    // Platform model (055): the price belongs to the product; the Bureau gets E2E_BUREAU_PCT of the gross price. The helper
    // writes the Bureau override as (price - cost) / price, so cost 14.00 on price 20.00 gives 30%.
    await setPlatformSale(owner, { bureauId, productId, salePrice: E2E.salePrice, salePricePerPartner: E2E.salePricePerPartner, cost: "14.00", setBy: staffId });
    await seedWalletTopup(owner, { bureauId, amount: "500.00", createdBy: staffId });
    await seedClientWalletTopup(owner, { clientProfileId: clientId, amount: "100.00", createdBy: staffId });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
}
