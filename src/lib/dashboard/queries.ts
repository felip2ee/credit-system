// Dashboard aggregates — direct SQL matching the previous Supabase filters.
// Period boundaries are computed by the caller in the Brasília time zone and
// passed as ISO strings; numeric columns are cast to float8 so JS gets numbers.
// No PoolClient escapes this module.

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export interface DashboardMetrics {
  counts: {
    today: number;
    month: number;
    scrPending: number;
    holders: number;
    aiCompleted: number;
    dossiersProcessing: number;
    cCompleted: number;
    cPending: number;
    cProcessing: number;
    cError: number;
  };
  scrStatuses: string[];
  aptitudes: (string | null)[];
  monthlyQueries: { created_at: string; type: "PF" | "PJ" }[];
}

export async function getDashboardMetrics(
  identity: DbIdentity,
  period: { startToday: string; startMonth: string; start6mo: string },
): Promise<DashboardMetrics> {
  return withUserTransaction(identity, async (client) => {
    const consultationCounts = await client.query<{
      today: number;
      month: number;
      c_completed: number;
      c_pending: number;
      c_processing: number;
      c_error: number;
    }>(
      `select
         count(*) filter (where created_at >= $1)::int as today,
         count(*) filter (where created_at >= $2)::int as month,
         count(*) filter (where status = 'completed')::int as c_completed,
         count(*) filter (where status = 'pending_authorization')::int as c_pending,
         count(*) filter (where status = 'processing')::int as c_processing,
         count(*) filter (where status = 'error')::int as c_error
       from consultations`,
      [period.startToday, period.startMonth],
    );

    const misc = await client.query<{
      scr_pending: number;
      holders: number;
      ai_completed: number;
      dossiers_processing: number;
    }>(
      `select
         (select count(*) from scr_authorizations where status = 'pending')::int as scr_pending,
         (select count(*) from holders)::int as holders,
         (select count(*) from ai_reports where status = 'completed')::int as ai_completed,
         (select count(*) from dossiers where status = 'processing')::int as dossiers_processing`,
    );

    const scr = await client.query<{ status: string }>(
      "select status from scr_authorizations",
    );
    const ai = await client.query<{ aptitude_status: string | null }>(
      "select aptitude_status from ai_reports",
    );
    const monthly = await client.query<{ created_at: string; type: "PF" | "PJ" }>(
      `select created_at::text, type
         from consultations
        where created_at >= $1`,
      [period.start6mo],
    );

    const cc = consultationCounts.rows[0];
    const m = misc.rows[0];
    return {
      counts: {
        today: cc.today,
        month: cc.month,
        scrPending: m.scr_pending,
        holders: m.holders,
        aiCompleted: m.ai_completed,
        dossiersProcessing: m.dossiers_processing,
        cCompleted: cc.c_completed,
        cPending: cc.c_pending,
        cProcessing: cc.c_processing,
        cError: cc.c_error,
      },
      scrStatuses: scr.rows.map((r) => r.status),
      aptitudes: ai.rows.map((r) => r.aptitude_status),
      monthlyQueries: monthly.rows,
    };
  });
}

export async function getTopbarEmail(
  identity: DbIdentity,
): Promise<string | null> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ email: string }>(
      "select email from profiles where id = $1",
      [identity.userId],
    );
    return rows[0]?.email ?? null;
  });
}

export interface RevenueSummary {
  total: { amount: number; orders: number };
  period: { amount: number; orders: number };
  monthly: { month: string; amount: number }[]; // "YYYY-MM", em Brasília
  clients: number;
}

// Faturamento = preço dos pedidos capturados (order_settlements.price, por data de captura). Não depende de comissão:
// a parte do Bureau e do afiliado vem do split da entrada de dinheiro (072).
// A RLS limita ao Bureau do usuário.
export async function getRevenueSummary(
  identity: DbIdentity,
  range: { start: string; end: string },
  seriesStart: string,
): Promise<RevenueSummary> {
  return withUserTransaction(identity, async (client) => {
    const sums = await client.query<{
      total_amount: number;
      total_orders: number;
      period_amount: number;
      period_orders: number;
    }>(
      `select
         coalesce(sum(price), 0)::float8 as total_amount,
         count(*)::int as total_orders,
         coalesce(sum(price) filter (where closed_at >= $1 and closed_at < $2), 0)::float8 as period_amount,
         (count(*) filter (where closed_at >= $1 and closed_at < $2))::int as period_orders
       from order_settlements
      where status = 'captured'`,
      [range.start, range.end],
    );
    const monthly = await client.query<{ month: string; amount: number }>(
      `select to_char(closed_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as month,
              sum(price)::float8 as amount
         from order_settlements
        where status = 'captured' and closed_at >= $1
        group by 1
        order by 1`,
      [seriesStart],
    );
    const clients = await client.query<{ n: number }>(
      "select count(*)::int as n from profiles where role = 'client'",
    );
    const s = sums.rows[0];
    return {
      total: { amount: s.total_amount, orders: s.total_orders },
      period: { amount: s.period_amount, orders: s.period_orders },
      monthly: monthly.rows,
      clients: clients.rows[0].n,
    };
  });
}
