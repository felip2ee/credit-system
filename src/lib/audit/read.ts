// Audit trail reads — bureau_admin (do Bureau) e superadmin (plataforma e suporte) — 004_rls.sql: audit_logs_select.
// Parameterized SQL under the Task 3 transaction/RLS boundary; no PoolClient
// escapes this module.

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export interface AuditLogRow {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  supportSessionId: string | null;
  actor_name: string | null;
  actor_email: string | null;
}

const SELECT_COLUMNS = `a.id, a.action, a.metadata, a.new_data, a.ip_address::text,
              a.created_at::text, a.support_session_id as "supportSessionId",
              p.full_name as actor_name, p.email as actor_email`;

// Filters mirror audit_logs_select so each arm uses its own index:
// audit_logs_bureau_date_idx, audit_logs_platform_idx, audit_logs_support_idx, audit_logs_cost_idx.
const BUREAU_SQL = `select ${SELECT_COLUMNS}
         from audit_logs a
         left join profiles p on p.id = a.user_id
        where a.bureau_id = app_bureau_id()
        order by a.created_at desc
        limit $1`;

const PLATFORM_SQL = `select ${SELECT_COLUMNS}
         from (
           (select * from audit_logs where bureau_id is null
             order by created_at desc limit $1)
           union all
           (select * from audit_logs where support_session_id is not null and bureau_id is not null
             order by created_at desc limit $1)
           union all
           (select * from audit_logs where action = 'catalog.cost.set'
              and support_session_id is null and bureau_id is not null
             order by created_at desc limit $1)
         ) a
         left join profiles p on p.id = a.user_id
        order by a.created_at desc
        limit $1`;

export async function listAuditLogs(
  identity: DbIdentity,
  limit = 200,
): Promise<AuditLogRow[]> {
  const sql = identity.role === "superadmin" ? PLATFORM_SQL : BUREAU_SQL;
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<AuditLogRow>(sql, [limit]);
    return rows;
  });
}
