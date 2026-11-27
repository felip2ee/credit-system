import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { migrate } from "./migrate.mjs";
import { ADJUSTMENT_REASON, formatReport, zeroLegacyPayables } from "./zero-legacy-bureau-payables.mjs";

const ADMIN_URL = "postgres://postgres:test@127.0.0.1:54329/postgres";

// Banco próprio (como migrate.test.mjs), para não disputar linhas com a suíte de integração.
async function withTempDatabase(fn) {
  const name = `zero_payables_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
    const url = `postgres://postgres:test@127.0.0.1:54329/${name}`;
    await migrate(url);
    await fn(url);
  } finally {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

// Dono sem gatilhos nem FKs (replica): os lançamentos entram como a produção os deixou, sem montar pedidos.
async function seed(client, bureauName, entries) {
  const slug = `z-${randomUUID().slice(0, 8)}`;
  const { rows } = await client.query("insert into bureaus (name, slug) values ($1, $2) returning id", [bureauName, slug]);
  const bureauId = rows[0].id;
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  for (const [kind, amount, extra] of entries) {
    await client.query(
      `insert into bureau_payable_entries (bureau_id, kind, amount, order_ref, pix_charge_id, created_at)
       values ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval)`,
      [bureauId, kind, amount, extra?.pixChargeId ? null : randomUUID(), extra?.pixChargeId ?? null, extra?.daysAgo ?? 60],
    );
  }
  await client.query("commit");
  return bureauId;
}

const snapshot = async (client) =>
  (await client.query("select bureau_id, kind, amount::text, adjustment_reason from bureau_payable_entries order by created_at, id")).rows;

test("dry-run lists the open legacy balance per bureau and writes nothing", async () => {
  await withTempDatabase(async (url) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const a = await seed(client, "Bureau A", [["accrual", 300, { daysAgo: 90 }], ["reversal", -50, { daysAgo: 80 }], ["coupon_cost", -20, { daysAgo: 70 }]]);
      await seed(client, "Bureau Zero", [["accrual", 10], ["reversal", -10]]);
      const before = await snapshot(client);

      const report = await zeroLegacyPayables({ connectionString: url });

      assert.equal(report.mode, "dry-run");
      assert.deepEqual(report.rows, [{ bureauId: a, name: "Bureau A", openBalance: "230.00", entries: 3, status: "listed" }]);
      assert.deepEqual(await snapshot(client), before);
      assert.match(formatReport(report), /dry-run \(nada foi gravado/);
    } finally {
      await client.end();
    }
  });
});

test("apply writes one audited adjustment per bureau, keeps every row, and a second run writes nothing", async () => {
  await withTempDatabase(async (url) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const a = await seed(client, "Bureau A", [["accrual", 300, { daysAgo: 90 }], ["accrual", 120.5, { daysAgo: 85 }]]);
      const b = await seed(client, "Bureau B", [["accrual", 40, { daysAgo: 75 }]]);
      const rowsBefore = await snapshot(client);

      const first = await zeroLegacyPayables({ connectionString: url, apply: true });

      assert.deepEqual(first.rows.map((r) => [r.name, r.openBalance, r.status]), [["Bureau A", "420.50", "zeroed"], ["Bureau B", "40.00", "zeroed"]]);
      const after = await snapshot(client);
      assert.equal(after.length, rowsBefore.length + 2);
      for (const row of rowsBefore) assert.ok(after.some((x) => x.bureau_id === row.bureau_id && x.kind === row.kind && x.amount === row.amount));
      const adjustments = after.filter((r) => r.adjustment_reason);
      const byBureau = new Map(adjustments.map((r) => [r.bureau_id, r]));
      assert.equal(adjustments.length, 2);
      assert.deepEqual([byBureau.get(a).kind, byBureau.get(a).amount, byBureau.get(a).adjustment_reason], ["reversal", "-420.50", ADJUSTMENT_REASON]);
      assert.deepEqual([byBureau.get(b).kind, byBureau.get(b).amount, byBureau.get(b).adjustment_reason], ["reversal", "-40.00", ADJUSTMENT_REASON]);
      // O saldo lido pelo repasse (payable_buckets) fecha em zero: o ajuste cai no mesmo corte de retenção dos lançamentos.
      const sum = await client.query("select bureau_id, sum(amount)::text as s from bureau_payable_entries group by bureau_id");
      assert.ok(sum.rows.every((r) => r.s === "0.00"));
      const audits = await client.query("select bureau_id, metadata from audit_logs where action = 'payable.legacy_zeroed' order by metadata ->> 'amount'");
      assert.equal(audits.rowCount, 2);

      const second = await zeroLegacyPayables({ connectionString: url, apply: true });

      assert.deepEqual(second.rows, []);
      assert.equal((await snapshot(client)).length, after.length);
      assert.equal((await client.query("select count(*)::int as n from audit_logs where action = 'payable.legacy_zeroed'")).rows[0].n, 2);
    } finally {
      await client.end();
    }
  });
});

test("cash-in accruals, linked reversals, payout items and debts are left alone", async () => {
  await withTempDatabase(async (url) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const cashIn = await seed(client, "Bureau Cash In", [["accrual", 60, { pixChargeId: randomUUID() }]]);
      const debt = await seed(client, "Bureau Debt", [["reversal", -75]]);
      const before = await snapshot(client);

      const report = await zeroLegacyPayables({ connectionString: url, apply: true });

      assert.deepEqual(report.rows, [{ bureauId: debt, name: "Bureau Debt", openBalance: "-75.00", entries: 1, status: "skipped_debt" }]);
      assert.deepEqual(await snapshot(client), before);
      assert.ok(cashIn);
    } finally {
      await client.end();
    }
  });
});

test("refuses a missing URL and an owner that does not bypass RLS", async () => {
  await assert.rejects(zeroLegacyPayables({ connectionString: "" }), /DATABASE_OWNER_URL is required/);
  await withTempDatabase(async (url) => {
    const probe = new pg.Client({ connectionString: url });
    const role = `zero_norls_${process.pid}`;
    await probe.connect();
    try {
      await probe.query(`create role ${role} login password 'test' nosuperuser nobypassrls`);
      await probe.query(`grant connect on database ${url.split("/").pop()} to ${role}`);
      await assert.rejects(
        zeroLegacyPayables({ connectionString: url.replace("postgres:test", `${role}:test`) }),
        /ignore RLS/,
      );
    } finally {
      await probe.query(`drop owned by ${role}`).catch(() => {});
      await probe.query(`drop role if exists ${role}`);
      await probe.end();
    }
  });
});
