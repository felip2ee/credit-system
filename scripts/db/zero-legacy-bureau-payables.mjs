// Zera os saldos antigos de comissão do bureau em bureau_payable_entries (plano afiliado-bureaus, parte 1, task 6).
// Eles já foram repassados fora do sistema. Não apaga nada (a tabela é append-only): grava UM lançamento de ajuste por
// bureau, kind 'reversal' (os leitores de saldo e de repasse já somam esse kind) com adjustment_reason (073), sem
// cobrança nem pedido, mais um evento de auditoria 'payable.legacy_zeroed' na mesma transação.
//   node scripts/db/zero-legacy-bureau-payables.mjs             lista (--dry-run é o padrão), não altera nada
//   node scripts/db/zero-legacy-bureau-payables.mjs --apply     grava os ajustes
// Saldo "legado" = lançamentos contados no saldo a repassar (accrual, reversal, coupon_cost, coupon_refund) que nenhum
// repasse pegou, menos o que nasceu da entrada de dinheiro (accrual com cobrança e o estorno ligado a ele): esses são
// repasses devidos de verdade. Idempotente: depois do ajuste a soma do legado é zero e a segunda execução não grava nada.
// Saldo negativo (dívida do bureau) só é listado, nunca ajustado. O ajuste leva a data do lançamento mais novo que ele
// zera, para cair no mesmo corte de retenção e de repasse (create_payout); rode antes de criar qualquer repasse.
// Usa DATABASE_OWNER_URL (dono que ignora RLS). Não roda sozinho: o usuário executa em produção depois de conferir a lista.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { hydrateSecretEnv } from "../../src/lib/runtime-secrets.mjs";

export const ADJUSTMENT_REASON = "Saldo anterior repassado fora do sistema (zerado por script)";

const LEGACY_OPEN = `
  e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
  and not exists (select 1 from public.payout_items i where i.entry_id = e.id)
  and not (e.kind = 'accrual' and e.pix_charge_id is not null)
  and e.reverses_entry_id is null`;

// Linhas por bureau com saldo legado diferente de zero. Lê com a transação do cliente recebido.
async function listOpen(client, bureauId = null) {
  const { rows } = await client.query(
    `select e.bureau_id, b.name, sum(e.amount)::numeric(15,2)::text as open_balance, count(*)::int as entries,
            max(e.created_at) as newest
       from public.bureau_payable_entries e
       join public.bureaus b on b.id = e.bureau_id
      where ${LEGACY_OPEN} and ($1::uuid is null or e.bureau_id = $1)
      group by e.bureau_id, b.name
     having sum(e.amount) <> 0
      order by b.name, e.bureau_id`,
    [bureauId],
  );
  return rows;
}

// O dono precisa ignorar RLS (superusuário ou BYPASSRLS): com FORCE RLS um dono comum não leria nem gravaria nada.
async function assertBypassRls(client) {
  const { rows } = await client.query(
    "select rolsuper or rolbypassrls as ok from pg_roles where rolname = current_user",
  );
  if (!rows[0]?.ok) throw new Error("DATABASE_OWNER_URL precisa de um papel que ignore RLS (superusuário ou BYPASSRLS)");
}

// Retorna { mode, rows: [{ bureauId, name, openBalance, entries, status }] }. status: listed | zeroed | skipped_debt | skipped_empty.
export async function zeroLegacyPayables({ connectionString = process.env.DATABASE_OWNER_URL, apply = false } = {}) {
  if (!connectionString) throw new Error("DATABASE_OWNER_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await assertBypassRls(client);
    const found = await listOpen(client);
    const rows = [];
    for (const row of found) {
      const base = { bureauId: row.bureau_id, name: row.name, openBalance: row.open_balance, entries: row.entries };
      if (!apply) {
        rows.push({ ...base, status: Number(row.open_balance) < 0 ? "skipped_debt" : "listed" });
        continue;
      }
      await client.query("begin");
      try {
        // Mesmo lock de create_payout: um repasse em curso e este ajuste se enfileiram. A soma é relida dentro do lock.
        await client.query("select pg_advisory_xact_lock(hashtextextended('payout:' || $1::text, 0))", [row.bureau_id]);
        const [current] = await listOpen(client, row.bureau_id);
        if (!current) {
          rows.push({ ...base, status: "skipped_empty" });
          await client.query("rollback");
          continue;
        }
        if (Number(current.open_balance) < 0) {
          rows.push({ ...base, openBalance: current.open_balance, status: "skipped_debt" });
          await client.query("rollback");
          continue;
        }
        const { rows: inserted } = await client.query(
          `insert into public.bureau_payable_entries (bureau_id, kind, amount, adjustment_reason, created_at)
           values ($1, 'reversal', -$2::numeric, $3, $4) returning id`,
          [row.bureau_id, current.open_balance, ADJUSTMENT_REASON, current.newest],
        );
        await client.query(
          `insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
           values ($1, null, 'payable.legacy_zeroed', 'bureau_payable_entries', $2, $3::jsonb)`,
          [row.bureau_id, inserted[0].id, JSON.stringify({ amount: current.open_balance, entries: current.entries })],
        );
        await client.query("commit");
        rows.push({ ...base, openBalance: current.open_balance, entries: current.entries, status: "zeroed" });
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    return { mode: apply ? "apply" : "dry-run", rows };
  } finally {
    await client.end();
  }
}

export function formatReport({ mode, rows }) {
  const lines = [`modo: ${mode}${mode === "dry-run" ? " (nada foi gravado; use --apply para zerar)" : ""}`];
  for (const row of rows) {
    lines.push(`${row.status}\t${row.bureauId}\t${row.name}\tsaldo ${row.openBalance}\t${row.entries} lançamentos`);
  }
  if (rows.length === 0) lines.push("nenhum bureau com saldo antigo em aberto");
  return lines.join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hydrateSecretEnv(process.env);
  const args = process.argv.slice(2);
  if (args.includes("--apply") && args.includes("--dry-run")) {
    console.error("use --apply ou --dry-run, não os dois");
    process.exitCode = 1;
  } else {
    zeroLegacyPayables({ apply: args.includes("--apply") })
      .then((report) => console.log(formatReport(report)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
