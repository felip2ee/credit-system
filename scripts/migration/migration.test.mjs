// Exercises the migration core against an in-process fake source + in-memory
// store + a stub version-1 adapter. No Supabase, no Postgres, no Docker.
// Real DB execution is deferred to the Task 15 rehearsal gate.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyStorage, exportAll, importAll, verify } from "./lib.mjs";

// ── fixture: fixed UUIDs + timestamps ───────────────────────────────────
const U = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const DOC1 = "33333333-3333-3333-3333-333333333333";
const DOC2 = "33333333-3333-3333-3333-333333333334";
const CONS_OK = "44444444-4444-4444-4444-444444444444";
const CONS_BAD = "44444444-4444-4444-4444-444444444445";
const PAY_OK = "55555555-5555-5555-5555-555555555555";
const PAY_BAD = "55555555-5555-5555-5555-555555555556";
const AUDIT = "66666666-6666-6666-6666-666666666666";
const TS = "2026-01-02T03:04:05.000Z";

const VALID_BODY = { pessoa: { data: { nome: "Fulano", cpf: "12345678901" } } };
const BAD_BODY = { garbage: true };

function fakeSource() {
  const tables = {
    credit_products: [],
    profiles: [
      { id: U, auth_user_id: U, full_name: "Fulano", email: "fulano@example.com", role: "consultant", is_active: true, created_at: TS, updated_at: TS },
    ],
    crm_clients: [
      { id: CLIENT, type: "PF", name: "Cliente", document: "12345678901", created_by: U, created_at: TS, updated_at: TS },
    ],
    crm_client_documents: [
      { id: DOC1, client_id: CLIENT, type: "PF", document: "12345678901", created_at: TS },
      { id: DOC2, client_id: CLIENT, type: "PF", document: "98765432100", created_at: TS },
    ],
    crm_client_relations: [],
    batches: [],
    consultations: [
      { id: CONS_OK, type: "PF", document: "12345678901", created_by: U, status: "processing", created_at: TS, updated_at: TS },
      { id: CONS_BAD, type: "PF", document: "98765432100", created_by: U, status: "processing", created_at: TS, updated_at: TS },
    ],
    scr_authorizations: [],
    bureau_payloads: [
      { id: PAY_OK, consultation_id: CONS_OK, provider: "deps", product: "pf", received_at: TS, http_status: 200, payload: VALID_BODY, payload_sha256: "0".repeat(64), validation_status: "pending", validation_errors: [] },
      { id: PAY_BAD, consultation_id: CONS_BAD, provider: "deps", product: "pf", received_at: TS, http_status: 200, payload: BAD_BODY, payload_sha256: "1".repeat(64), validation_status: "pending", validation_errors: [] },
    ],
    ai_reports: [],
    company_reports: [],
    opportunities: [],
    opportunity_documents: [],
    timeline_events: [],
    crm_notes: [],
    settings: [],
    audit_logs: [
      { id: AUDIT, action: "user.invite", table_name: "profiles", record_id: U, outcome: "success", created_at: TS },
    ],
  };
  return {
    readTable: async (name) => structuredClone(tables[name]),
    listIdentities: async () => [
      // legacy row carrying credentials that MUST NOT be exported
      { id: U, email: "Fulano@Example.com", name: "Fulano", role: "consultant", is_active: true, created_at: TS, updated_at: TS, password_hash: "LEGACY", totp_secret: "LEGACY", session_token: "LEGACY" },
    ],
    async *listStorageObjects() {
      yield { bucket: "docs", path: "a.txt" };
      yield { bucket: "docs", path: "nested/b.txt" };
    },
    openStorageObject: async (_bucket, path) => (async function* () {
      yield Buffer.from(`content-of-${path}`);
    })(),
  };
}

// stub adapter: version 1 contract from src/lib/deps/adapter.ts
function stubAdapt(body) {
  if (body && body.pessoa) {
    return {
      ok: true,
      version: 1,
      value: {
        document: { type: "cpf", value: "12345678901" },
        subject: { kind: "PF", name: "Fulano" },
        score: { value: 700, riskBand: "low" },
      },
    };
  }
  return { ok: false, errors: [{ path: "", code: "root_not_object", message: "bad" }] };
}

function memStore() {
  const t = {};
  const tbl = (n) => (t[n] ||= []);
  return {
    _t: t,
    begin: async () => {},
    commit: async () => {},
    rollback: async () => {},
    has: async (name, id) => tbl(name).some((r) => (r.id ?? r.consultation_id) === id),
    insert: async (name, row) => { tbl(name).push({ ...row }); },
    allRows: async (name) => tbl(name).slice(),
    createAuthUser: async ({ id, email, name }) => {
      tbl("user").push({ id, email, name, email_verified: true });
      tbl("account").push({ id: `acct-${id}`, user_id: id, provider_id: "credential", password: "FRESH_HASH_NOT_LEGACY" });
    },
    setConsultationStatus: async (id, status) => {
      const c = tbl("consultations").find((r) => r.id === id);
      if (c) c.status = status;
    },
    setPayloadValidation: async (id, status, errs) => {
      const p = tbl("bureau_payloads").find((r) => r.id === id);
      if (p) { p.validation_status = status; p.validation_errors = errs; }
    },
  };
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "migration-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("export strips legacy secrets and records a manifest", async () => {
  await withTmp(async (dir) => {
    const manifest = await exportAll(fakeSource(), dir);
    assert.equal(manifest.tables.consultations.count, 2);
    assert.equal(manifest.tables.audit_logs.count, 1);
    assert.equal(manifest.tables.crm_client_documents.count, 2);
    assert.equal(manifest.tables.profiles.min, TS);

    const { readNdjson } = await import("./lib.mjs");
    const [identity] = await readNdjson(join(dir, "identities.ndjson"));
    assert.deepEqual(Object.keys(identity).sort(), [
      "created_at", "email", "id", "is_active", "name", "role", "updated_at",
    ]);
    assert.equal(identity.email, "fulano@example.com"); // normalized
    assert.equal(identity.password_hash, undefined);
    assert.equal(identity.totp_secret, undefined);
  });
});

test("import preserves ids/timestamps, derives results, marks reset; rerun is idempotent", async () => {
  await withTmp(async (dir) => {
    await exportAll(fakeSource(), dir);
    await copyStorage(fakeSource(), dir);

    const store = memStore();
    const first = await importAll({ dir, store, adapt: stubAdapt });
    assert.equal(first.identities, 1);
    assert.equal(first.results, 1);
    assert.equal(first.incompatible, 1);

    // ids + timestamps preserved
    const [client] = await store.allRows("crm_clients");
    assert.equal(client.id, CLIENT);
    assert.equal(client.created_at, TS);

    // profile marked must_reset_password
    const [profile] = await store.allRows("profiles");
    assert.equal(profile.must_reset_password, true);
    assert.equal(profile.id, U);

    // valid payload -> completed + bureau_result; bad payload -> payload_incompatible
    const cons = await store.allRows("consultations");
    assert.equal(cons.find((c) => c.id === CONS_OK).status, "completed");
    assert.equal(cons.find((c) => c.id === CONS_BAD).status, "payload_incompatible");
    const [result] = await store.allRows("bureau_results");
    assert.equal(result.consultation_id, CONS_OK);
    assert.equal(result.adapter_version, 1);

    // no legacy credential material
    assert.equal((await store.allRows("session")).length, 0);
    assert.equal((await store.allRows("two_factor")).length, 0);

    // rerun: nothing new inserted
    const second = await importAll({ dir, store, adapt: stubAdapt });
    assert.equal(second.identities, 0);
    assert.equal(second.results, 0);
    assert.equal(second.incompatible, 0);
    assert.equal((await store.allRows("crm_clients")).length, 1);
    assert.equal((await store.allRows("bureau_results")).length, 1);
  });
});

test("verify passes on a clean import and fails on a discrepancy", async () => {
  await withTmp(async (dir) => {
    await exportAll(fakeSource(), dir);
    await copyStorage(fakeSource(), dir);
    const store = memStore();
    await importAll({ dir, store, adapt: stubAdapt });

    const clean = await verify({ dir, store });
    assert.deepEqual(clean.errors, []);
    assert.equal(clean.ok, true);

    // tamper: drop a row from the target
    store._t.crm_client_documents.pop();
    const dirty = await verify({ dir, store });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.errors.some((e) => e.includes("crm_client_documents")));
  });
});

test("copy-storage hashes every object and re-verifies against disk", async () => {
  await withTmp(async (dir) => {
    const meta = await copyStorage(fakeSource(), dir);
    assert.equal(meta.count, 2);
    assert.equal(meta.errors.length, 0);
  });
});
