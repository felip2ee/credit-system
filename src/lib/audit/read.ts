// Audit trail reads — admin-only (004_rls.sql: audit_logs_admin_select).
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
  actor_name: string | null;
  actor_email: string | null;
}

export async function listAuditLogs(
  identity: DbIdentity,
  limit = 200,
): Promise<AuditLogRow[]> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<AuditLogRow>(
      `select a.id, a.action, a.metadata, a.new_data, a.ip_address::text,
              a.created_at::text,
              p.full_name as actor_name, p.email as actor_email
         from audit_logs a
         left join profiles p on p.id = a.user_id
        order by a.created_at desc
        limit $1`,
      [limit],
    );
    return rows;
  });
}
