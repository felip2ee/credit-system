// Repeatable Supabase -> Postgres data migration: pure, testable core.
//
// Scope: READ-ONLY export + import/verify TOOLING a human runs during an
// authorized cutover rehearsal. This module never opens a network connection
// itself -- callers inject a `source` (export) or a `store` (import/verify).
// DB / Supabase wiring lives in the sibling *.mjs entrypoints.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

// ── business tables, in FK dependency order ──────────────────────────────
// `bureau_results` is intentionally absent: it is DERIVED on import by
// replaying raw `bureau_payloads` through the production adapter (version 1).
export const TABLE_ORDER = [
  "credit_products",
  "profiles",
  "crm_clients",
  "crm_client_documents",
  "crm_client_relations",
  "batches",
  "consultations",
  "scr_authorizations",
  "bureau_payloads",
  "ai_reports",
  "company_reports",
  "opportunities",
  "opportunity_documents",
  "timeline_events",
  "crm_notes",
  "settings",
  "audit_logs",
];

// Foreign keys verify checks post-import: [column, referencedTable, referencedColumn].
// Nullable FKs are skipped when the column is null. Derived `bureau_results` included.
export const FOREIGN_KEYS = {
  profiles: [["auth_user_id", "user", "id"]],
  crm_clients: [["created_by", "profiles", "id"]],
  crm_client_documents: [["client_id", "crm_clients", "id"]],
  crm_client_relations: [
    ["client_id", "crm_clients", "id"],
    ["related_id", "crm_clients", "id"],
  ],
  batches: [["created_by", "profiles", "id"]],
  consultations: [
    ["created_by", "profiles", "id"],
    ["crm_client_id", "crm_clients", "id"],
    ["batch_id", "batches", "id"],
  ],
  scr_authorizations: [
    ["consultation_id", "consultations", "id"],
    ["crm_client_id", "crm_clients", "id"],
    ["requested_by", "profiles", "id"],
  ],
  bureau_payloads: [["consultation_id", "consultations", "id"]],
  bureau_results: [
    ["consultation_id", "consultations", "id"],
    ["payload_id", "bureau_payloads", "id"],
  ],
  ai_reports: [
    ["consultation_id", "consultations", "id"],
    ["crm_client_id", "crm_clients", "id"],
  ],
  company_reports: [
    ["batch_id", "batches", "id"],
    ["created_by", "profiles", "id"],
  ],
  opportunities: [
    ["crm_client_id", "crm_clients", "id"],
    ["consultation_id", "consultations", "id"],
    ["credit_product_id", "credit_products", "id"],
    ["created_by", "profiles", "id"],
  ],
  opportunity_documents: [["opportunity_id", "opportunities", "id"]],
  timeline_events: [["created_by", "profiles", "id"]],
  crm_notes: [["created_by", "profiles", "id"]],
  audit_logs: [["user_id", "profiles", "id"]],
};

// DB columns that hold a storage object key/path. verify asserts each non-null
// value resolves to a copied object (missing referenced file = fatal).
export const STORAGE_REFERENCES = {
  opportunity_documents: ["object_key", "file_path"],
  batches: ["file_path", "report_path"],
};

// Identity export is METADATA ONLY. Everything else on a legacy user row is a
// reusable credential and must never leave Supabase.
export const IDENTITY_COLUMNS = [
  "id",
  "email",
  "name",
  "role",
  "is_active",
  "created_at",
  "updated_at",
];

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

// ── production adapter loader ────────────────────────────────────────────
// Loads the REAL DEPS adapter (version 1) from src/. It is TypeScript using the
// `@/` alias; Node strips the types natively, this hook maps `@/x` -> src/x.
// `new URL("../../src/", import.meta.url)` keeps the trailing slash so
// `base + "types/bureau.ts"` resolves correctly.
let _adapterHookInstalled = false;
export async function loadAdapter() {
  if (!_adapterHookInstalled) {
    const srcRoot = new URL("../../src/", import.meta.url).href;
    register(
      "data:text/javascript," +
        encodeURIComponent(`
        const srcRoot = ${JSON.stringify(srcRoot)};
        export async function resolve(spec, ctx, next) {
          if (spec.startsWith("@/")) {
            for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
              try { return await next(srcRoot + spec.slice(2) + ext, ctx); } catch {}
            }
          }
          return next(spec, ctx);
        }`),
      import.meta.url,
    );
    _adapterHookInstalled = true;
  }
  const mod = await import(new URL("../../src/lib/deps/adapter.ts", import.meta.url).href);
  return mod.adapt;
}

// Deterministic UTF-8 JSON (recursively sorted keys) -- mirrors
// src/lib/consultations/service.ts so re-hashing a payload here matches runtime.
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const payloadSha256 = (body) => sha256Hex(canonicalJson(body));

function timestampRange(rows) {
  let min = null;
  let max = null;
  for (const row of rows) {
    for (const key of ["created_at", "updated_at", "received_at", "requested_at"]) {
      const v = row[key];
      if (!v) continue;
      const t = new Date(v).toISOString();
      if (min === null || t < min) min = t;
      if (max === null || t > max) max = t;
    }
  }
  return { min, max };
}

// Whitelist-only: every legacy column outside IDENTITY_COLUMNS is dropped here,
// so password hashes / tokens / MFA secrets physically cannot reach the export.
export function sanitizeIdentity(raw) {
  const out = {};
  for (const col of IDENTITY_COLUMNS) out[col] = raw[col] ?? null;
  out.email = String(out.email || "").trim().toLowerCase();
  return out;
}

async function writeNdjson(file, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
  return { file, count: rows.length, sha256: sha256Hex(Buffer.from(body, "utf8")) };
}

async function readNdjson(file) {
  const body = await readFile(file, "utf8");
  return body
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ── export ──────────────────────────────────────────────────────────────
// `source` contract (see export-supabase.mjs for the Postgres-backed impl):
//   readTable(name) -> Promise<row[]>          active business rows
//   listIdentities() -> Promise<rawUserRow[]>  full legacy rows (sanitized here)
export async function exportAll(source, outDir) {
  await mkdir(outDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    adapterVersion: 1,
    tables: {},
    identities: null,
  };

  for (let i = 0; i < TABLE_ORDER.length; i++) {
    const name = TABLE_ORDER[i];
    const rows = await source.readTable(name);
    const prefix = String(i + 1).padStart(2, "0");
    const meta = await writeNdjson(join(outDir, `${prefix}_${name}.ndjson`), rows);
    manifest.tables[name] = {
      ...meta,
      file: `${prefix}_${name}.ndjson`,
      ...timestampRange(rows),
    };
  }

  const identities = (await source.listIdentities()).map(sanitizeIdentity);
  const idMeta = await writeNdjson(join(outDir, "identities.ndjson"), identities);
  manifest.identities = { ...idMeta, file: "identities.ndjson" };

  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

// ── storage ─────────────────────────────────────────────────────────────
// Streams one object at a time to disk while hashing; a whole bucket is never
// buffered. Missing / unreadable objects are recorded as fatal, not swallowed.
export async function copyStorage(source, outDir) {
  const storageDir = join(outDir, "storage");
  await mkdir(storageDir, { recursive: true });
  const entries = [];
  const errors = [];

  for await (const obj of source.listStorageObjects()) {
    const dest = join(storageDir, obj.bucket, obj.path);
    await mkdir(dirname(dest), { recursive: true });
    try {
      const hash = createHash("sha256");
      const body = await source.openStorageObject(obj.bucket, obj.path);
      const sink = createWriteStream(dest);
      let bytes = 0;
      await pipeline(body, async function* (chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          hash.update(chunk);
          yield chunk;
        }
      }, sink);
      entries.push({
        bucket: obj.bucket,
        path: obj.path,
        size: bytes,
        sha256: hash.digest("hex"),
      });
    } catch (err) {
      errors.push({ bucket: obj.bucket, path: obj.path, error: String(err?.message || err) });
    }
  }

  const meta = await writeNdjson(join(outDir, "storage-manifest.ndjson"), entries);
  await writeFile(
    join(outDir, "storage-errors.json"),
    JSON.stringify(errors, null, 2) + "\n",
    "utf8",
  );
  if (errors.length > 0) {
    throw new Error(`copy-storage: ${errors.length} object(s) missing or unreadable`);
  }
  return { ...meta, count: entries.length, errors };
}

// ── import ──────────────────────────────────────────────────────────────
export const freshPassword = () => randomBytes(32).toString("base64");

// `store` contract (see import-postgres.mjs for the pg + Better Auth impl):
//   begin()/commit()/rollback()
//   has(table, id) -> Promise<boolean>
//   insert(table, row) -> Promise<void>          parameterized, preserves id/ts
//   createAuthUser({ id, email, name }) -> Promise<void>  fresh 32-byte pw, hashed, plaintext discarded
//   allRows(table) -> Promise<row[]>
export async function importAll({ dir, store, adapt }) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const summary = { inserted: {}, skipped: {}, identities: 0, results: 0, incompatible: 0 };

  await store.begin();
  try {
    // 1. identities first -- profiles FK "user"(id).
    for (const id of await readNdjson(join(dir, manifest.identities.file))) {
      if (await store.has("user", id.id)) {
        summary.skipped.user = (summary.skipped.user || 0) + 1;
        continue;
      }
      // Fresh random 32-byte password, hashed by Better Auth, plaintext dropped
      // on return. NO legacy credential is ever imported.
      await store.createAuthUser({ id: id.id, email: id.email, name: id.name });
      summary.identities++;
    }

    // 2. business tables in dependency order.
    for (const name of TABLE_ORDER) {
      const rows = await readNdjson(join(dir, manifest.tables[name].file));
      for (const row of rows) {
        if (row.id && (await store.has(name, row.id))) {
          summary.skipped[name] = (summary.skipped[name] || 0) + 1;
          continue;
        }
        if (name === "profiles") row.must_reset_password = true;
        await store.insert(name, row);
        summary.inserted[name] = (summary.inserted[name] || 0) + 1;
      }
    }

    // 3. derive canonical results by replaying raw payloads (adapter version 1).
    const settled = new Set(
      (await store.allRows("bureau_payloads"))
        .filter((p) => p.validation_status && p.validation_status !== "pending")
        .map((p) => p.id),
    );
    for (const payload of await readNdjson(join(dir, manifest.tables.bureau_payloads.file))) {
      if (settled.has(payload.id) || (await store.has("bureau_results", payload.consultation_id))) {
        summary.skipped.bureau_results = (summary.skipped.bureau_results || 0) + 1;
        continue;
      }
      const body = typeof payload.payload === "string" ? JSON.parse(payload.payload) : payload.payload;
      const result = adapt(body, {
        product: payload.product,
        httpStatus: payload.http_status,
        receivedAt: payload.received_at,
      });
      if (result.ok) {
        const c = result.value;
        await store.insert("bureau_results", {
          consultation_id: payload.consultation_id,
          payload_id: payload.id,
          adapter_version: result.version,
          canonical_result: JSON.stringify(c),
          document: c.document.value,
          person_name: c.subject.name,
          score: c.score?.value ?? null,
          risk_level: c.score?.riskBand ?? null,
        });
        await store.setConsultationStatus(payload.consultation_id, "completed");
        await store.setPayloadValidation(payload.id, "valid", []);
        summary.results++;
      } else {
        await store.setPayloadValidation(payload.id, "incompatible", result.errors);
        await store.setConsultationStatus(payload.consultation_id, "payload_incompatible");
        summary.incompatible++;
      }
    }

    await store.commit();
  } catch (err) {
    await store.rollback();
    throw err;
  }
  return summary;
}

// ── verify ──────────────────────────────────────────────────────────────
// Returns { ok, errors[] }. Callers exit nonzero when ok === false.
export async function verify({ dir, store }) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const errors = [];
  const fail = (m) => errors.push(m);

  // exact row counts per active table
  for (const name of TABLE_ORDER) {
    const want = manifest.tables[name].count;
    const got = (await store.allRows(name)).length;
    if (want !== got) fail(`row count mismatch ${name}: manifest ${want} target ${got}`);
  }

  // ── every foreign key: referenced row must exist ──────────────────────
  const rowCache = {};
  const rowsOf = async (t) => (rowCache[t] ||= await store.allRows(t));
  for (const [table, fks] of Object.entries(FOREIGN_KEYS)) {
    for (const [col, refTable, refCol] of fks) {
      const targetIds = new Set((await rowsOf(refTable)).map((r) => r[refCol]));
      for (const row of await rowsOf(table)) {
        const v = row[col];
        if (v == null) continue; // nullable FK
        if (!targetIds.has(v)) fail(`${table}.${col}=${v} -> missing ${refTable}.${refCol}`);
      }
    }
  }

  const profiles = await rowsOf("profiles");
  for (const p of profiles) {
    if (p.must_reset_password !== true) fail(`profile ${p.id} not marked must_reset_password`);
  }

  // unique emails
  const emails = profiles.map((p) => String(p.email).toLowerCase());
  if (new Set(emails).size !== emails.length) fail("duplicate profile emails in target");

  // unique client documents (per client)
  const docs = (await store.allRows("crm_client_documents")).map(
    (d) => `${d.client_id}:${d.document}`,
  );
  if (new Set(docs).size !== docs.length) fail("duplicate crm_client_documents in target");

  // consultation <-> result consistency
  const consultations = new Map((await store.allRows("consultations")).map((c) => [c.id, c]));
  for (const r of await store.allRows("bureau_results")) {
    const c = consultations.get(r.consultation_id);
    if (!c) fail(`bureau_result references missing consultation ${r.consultation_id}`);
    else if (c.status !== "completed") fail(`consultation ${c.id} has result but status ${c.status}`);
  }

  // absence of imported password / session / MFA material
  for (const t of ["session", "two_factor", "verification"]) {
    const n = (await store.allRows(t)).length;
    if (n !== 0) fail(`legacy ${t} data present in target (${n} rows)`);
  }
  const identities = await readNdjson(join(dir, manifest.identities.file));
  for (const id of identities) {
    for (const key of Object.keys(id)) {
      if (!IDENTITY_COLUMNS.includes(key)) fail(`identity export leaked field "${key}"`);
    }
  }

  // audit append-only: every source audit row preserved by id
  const auditTargetIds = new Set((await store.allRows("audit_logs")).map((a) => a.id));
  for (const a of await readNdjson(join(dir, manifest.tables.audit_logs.file))) {
    if (!auditTargetIds.has(a.id)) fail(`audit log ${a.id} missing from target`);
  }

  // storage: source manifest hash vs bytes on disk (streamed, never buffered),
  // then every DB file reference must resolve to a copied object.
  let storageManifest = null;
  try {
    storageManifest = await readNdjson(join(dir, "storage-manifest.ndjson"));
  } catch {
    /* storage step not run in this export -- table checks above still apply */
  }
  if (storageManifest) {
    const copied = new Set();
    for (const obj of storageManifest) {
      copied.add(obj.path);
      copied.add(`${obj.bucket}/${obj.path}`);
      try {
        const got = await sha256File(join(dir, "storage", obj.bucket, obj.path));
        if (got !== obj.sha256) fail(`storage hash mismatch ${obj.bucket}/${obj.path}`);
      } catch {
        fail(`storage object missing on disk ${obj.bucket}/${obj.path}`);
      }
    }
    for (const [table, cols] of Object.entries(STORAGE_REFERENCES)) {
      for (const row of await rowsOf(table)) {
        for (const col of cols) {
          const ref = row[col];
          if (ref == null || ref === "") continue;
          if (!copied.has(ref) && !copied.has(String(ref).replace(/^\/+/, ""))) {
            fail(`${table}.${col}=${ref} references an object absent from the copied storage set`);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Postgres-backed store (import + verify) ─────────────────────────────
// Wraps an already-connected `pg.Client`. `hashPassword` is Better Auth's
// configured hasher, injected so this module keeps zero heavy imports.
const ID_COLUMN = { bureau_results: "consultation_id", settings: "key", schema_migrations: "version" };

export function makePgStore(client, hashPassword) {
  const idCol = (table) => ID_COLUMN[table] || "id";
  return {
    begin: () => client.query("begin"),
    commit: () => client.query("commit"),
    rollback: () => client.query("rollback"),
    has: async (table, id) => {
      const { rowCount } = await client.query(
        `select 1 from "${table}" where "${idCol(table)}" = $1 limit 1`,
        [id],
      );
      return rowCount > 0;
    },
    insert: async (table, row) => {
      const cols = Object.keys(row);
      const values = cols.map((c) => {
        const v = row[c];
        return v !== null && typeof v === "object" && !(v instanceof Date)
          ? JSON.stringify(v)
          : v;
      });
      const params = cols.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `insert into "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) values (${params})`,
        values,
      );
    },
    allRows: async (table) => {
      const { rows } = await client.query(`select * from "${table}"`);
      return rows;
    },
    createAuthUser: async ({ id, email, name }) => {
      const hash = await hashPassword(freshPassword()); // plaintext dropped here
      await client.query(
        'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
        [id, name, email],
      );
      await client.query(
        `insert into account (id, issuer, account_id, provider_id, user_id, password, updated_at)
         values ($1, 'credential', $2, 'credential', $2, $3, now())`,
        [randomUUID(), id, hash],
      );
    },
    setConsultationStatus: (id, status) =>
      client.query(`update consultations set status = $2 where id = $1`, [id, status]),
    setPayloadValidation: (id, status, errors) =>
      client.query(
        `update bureau_payloads set validation_status = $2, validation_errors = $3::jsonb where id = $1`,
        [id, status, JSON.stringify(errors)],
      ),
  };
}

// ── shared CLI helpers ──────────────────────────────────────────────────
export function redactDsn(dsn) {
  try {
    const u = new URL(dsn);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "<unparseable-dsn>";
  }
}

export function requireArg(name, value) {
  if (!value) {
    console.error(`missing required ${name} (pass as arg or env)`);
    process.exit(2);
  }
  return value;
}

export { readNdjson, writeNdjson, sha256Hex, randomUUID };
