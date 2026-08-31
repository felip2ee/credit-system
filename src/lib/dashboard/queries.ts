// Dashboard aggregates — direct SQL matching the previous Supabase filters.
// Period boundaries are computed by the caller in the Brasília time zone and
// passed as ISO strings; numeric columns are cast to float8 so JS gets numbers.
// No PoolClient escapes this module.

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export interface DashboardOppRow {
  status: string;
  assigned_to: string | null;
  approved_amount: number | null;
  commission_rate: number | null;
  commission_amount: number | null;
}

export interface DashboardMetrics {
  counts: {
    today: number;
    month: number;
    scrPending: number;
    clients: number;
    aiCompleted: number;
    batchesProcessing: number;
    cCompleted: number;
    cPending: number;
    cProcessing: number;
    cError: number;
  };
  opportunities: DashboardOppRow[];
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
      clients: number;
      ai_completed: number;
      batches_processing: number;
    }>(
      `select
         (select count(*) from scr_authorizations where status = 'pending')::int as scr_pending,
         (select count(*) from crm_clients)::int as clients,
         (select count(*) from ai_reports where status = 'completed')::int as ai_completed,
         (select count(*) from batches where status = 'processing')::int as batches_processing`,
    );

    const opportunities = await client.query<DashboardOppRow>(
      `select status,
              assigned_to,
              approved_amount::float8   as approved_amount,
              commission_rate::float8   as commission_rate,
              commission_amount::float8 as commission_amount
         from opportunities`,
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
        clients: m.clients,
        aiCompleted: m.ai_completed,
        batchesProcessing: m.batches_processing,
        cCompleted: cc.c_completed,
        cPending: cc.c_pending,
        cProcessing: cc.c_processing,
        cError: cc.c_error,
      },
      opportunities: opportunities.rows,
      scrStatuses: scr.rows.map((r) => r.status),
      aptitudes: ai.rows.map((r) => r.aptitude_status),
      monthlyQueries: monthly.rows,
    };
  });
}

export async function getConsultantNames(
  identity: DbIdentity,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ id: string; full_name: string }>(
      "select id, full_name from profiles where id = any($1::uuid[])",
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r.full_name]));
  });
}
