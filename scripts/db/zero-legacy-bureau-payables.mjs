// Zera os saldos antigos de comissão do bureau em bureau_payable_entries (plano afiliado-bureaus, parte 1, task 6).
// Eles já foram repassados fora do sistema. Não apaga nada (a tabela é append-only): grava UM lançamento de ajuste por
// bureau, kind 'reversal' (os leitores de saldo e de repasse já somam esse kind) com adjustment_reason (073), sem
// cobrança nem pedido, mais um evento de auditoria 'payable.legacy_zeroed' na mesma transação.
//   node scripts/db/zero-legacy-bureau-payables.mjs                 lista (--dry-run é o padrão), não altera nada
//   node scripts/db/zero-legacy-bureau-payables.mjs --apply --yes   grava os ajustes (--yes é obrigatório com --apply)
// A primeira linha da saída é o banco alvo (host:porta/banco, nunca a senha): confira antes de confirmar.
// Saldo "legado" = lançamentos contados no saldo a repassar (accrual, reversal, coupon_cost, coupon_refund) que nenhum
// repasse pegou e que NÃO nasceram da entrada de dinheiro: qualquer linha com pix_charge_id fica de fora (accrual da
// entrada, o estorno ligado a ele e o clawback do estorno de cobrança, que é dívida nova e nunca é perdoada aqui).
// Idempotente: depois do ajuste a soma do legado é zero e a segunda execução não grava nada.
// Saldo negativo (dívida do bureau) só é listado, nunca ajustado.
// Retenção (046/047): payable_buckets e create_payout só seguram o accrual pela data; o reversal conta na hora, com
// qualquer data (por isso o ajuste não é retroativo: voltar a data dele não muda nada). Se o ajuste cobrisse um accrual
// ainda dentro da retenção, o bureau veria dívida até a janela passar. Por isso o ajuste zera só o que já está liberado
// (reversal, cupom e accrual mais velho que payable_retention_days) e a coluna "aguardando" lista o accrual legado
// ainda retido: rode o script de novo quando a janela passar (ou rode logo depois do deploy, quando o legado já tem
// mais de payable_retention_days). Não crie nenhum repasse (create_payout) antes do ajuste.
// Usa DATABASE_OWNER_URL (dono que ignora RLS). Não roda sozinho: o usuário executa em produção depois de conferir a lista.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { hydrateSecretEnv } from "../../src/lib/runtime-secrets.mjs";

export const ADJUSTMENT_REASON = "Saldo anterior repassado fora do sistema (zerado por script)";

const LEGACY_OPEN = `
  e.kind in ('accrual', 'reversal', 'coupon_cost', 'coupon_refund')
  and not exists (select 1 from public.payout_items i where i.entry_id = e.id)
  and e.pix_charge_id is null
  and e.reverses_entry_id is null`;

// Só o que já está liberado entra no ajuste: o accrual dentro da retenção (046) fica para depois. $2 é o corte.
const RELEASED = "(e.kind <> 'accrual' or e.created_at <= $2::timestamptz)";

// Linhas por bureau com saldo legado liberado ou aguardando a retenção. Lê com a transação do cliente recebido.
async function listOpen(client, retentionCutoff, bureauId = null) {
  const { rows } = await client.query(
    `select e.bureau_id, b.name,
            coalesce(sum(e.amount) filter (where ${RELEASED}), 0)::numeric(15,2)::text as open_balance,
            (count(*) filter (where ${RELEASED}))::int as entries,
            coalesce(sum(e.amount) filter (where not ${RELEASED}), 0)::numeric(15,2)::text as waiting
       from public.bureau_payable_entries e
       join public.bureaus b on b.id = e.bureau_id
      where ${LEGACY_OPEN} and ($1::uuid is null or e.bureau_id = $1)
      group by e.bureau_id, b.name
     having coalesce(sum(e.amount) filter (where ${RELEASED}), 0) <> 0
         or coalesce(sum(e.amount) filter (where not ${RELEASED}), 0) <> 0
      order by b.name, e.bureau_id`,
    [bureauId, retentionCutoff],
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

// Corte da retenção: o accrual mais novo que isto ainda não conta como liberado (payable_retention_days, 046).
async function retentionCutoff(client) {
  const { rows } = await client.query("select now() - make_interval(days => public.payable_retention_days()) as cutoff");
  return rows[0].cutoff;
}

// Host:porta/banco do alvo, sem usuário nem senha.
export function describeTarget(connectionString) {
  const { hostname, port, pathname } = new URL(connectionString);
  return `${hostname}${port ? `:${port}` : ""}${pathname}`;
}

// Retorna { mode, rows: [{ bureauId, name, openBalance, waiting, entries, status }] }.
// status: listed | zeroed | skipped_debt | skipped_empty | waiting (só accrual ainda retido, nada a zerar agora).
export async function zeroLegacyPayables({ connectionString = process.env.DATABASE_OWNER_URL, apply = false } = {}) {
  if (!connectionString) throw new Error("DATABASE_OWNER_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await assertBypassRls(client);
    const cutoff = await retentionCutoff(client);
    const found = await listOpen(client, cutoff);
    const rows = [];
    for (const row of found) {
      const base = { bureauId: row.bureau_id, name: row.name, openBalance: row.open_balance, waiting: row.waiting, entries: row.entries };
      const idle = Number(row.open_balance) === 0 ? "waiting" : Number(row.open_balance) < 0 ? "skipped_debt" : "listed";
      if (!apply || idle === "waiting") {
        rows.push({ ...base, status: idle });
        continue;
      }
      await client.query("begin");
      try {
        // Mesmo lock de create_payout: um repasse em curso e este ajuste se enfileiram. A soma é relida dentro do lock.
        await client.query("select pg_advisory_xact_lock(hashtextextended('payout:' || $1::text, 0))", [row.bureau_id]);
        const [current] = await listOpen(client, cutoff, row.bureau_id);
        if (!current || Number(current.open_balance) === 0) {
          rows.push({ ...base, status: "skipped_empty" });
          await client.query("rollback");
          continue;
        }
        if (Number(current.open_balance) < 0) {
          rows.push({ ...base, openBalance: current.open_balance, status: "skipped_debt" });
          await client.query("rollback");
          continue;
        }
        // Sem created_at: o reversal conta na hora com qualquer data (047), então voltar a data não mudaria nada.
        const { rows: inserted } = await client.query(
          `insert into public.bureau_payable_entries (bureau_id, kind, amount, adjustment_reason)
           values ($1, 'reversal', -$2::numeric, $3) returning id`,
          [row.bureau_id, current.open_balance, ADJUSTMENT_REASON],
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
  const lines = [`modo: ${mode}${mode === "dry-run" ? " (nada foi gravado; use --apply --yes para zerar)" : ""}`];
  for (const row of rows) {
    const waiting = Number(row.waiting) === 0 ? "" : `\taguardando retenção ${row.waiting}`;
    lines.push(`${row.status}\t${row.bureauId}\t${row.name}\tsaldo ${row.openBalance}\t${row.entries} lançamentos${waiting}`);
  }
  if (rows.length === 0) lines.push("nenhum bureau com saldo antigo em aberto");
  return lines.join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hydrateSecretEnv(process.env);
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (process.env.DATABASE_OWNER_URL) console.log(`banco alvo: ${describeTarget(process.env.DATABASE_OWNER_URL)}`);
  if (apply && args.includes("--dry-run")) {
    console.error("use --apply ou --dry-run, não os dois");
    process.exitCode = 1;
  } else if (apply && !args.includes("--yes")) {
    console.error("--apply grava no banco acima: confira o alvo e rode de novo com --apply --yes");
    process.exitCode = 1;
  } else {
    zeroLegacyPayables({ apply })
      .then((report) => console.log(formatReport(report)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
