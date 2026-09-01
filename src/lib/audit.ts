import { writeAuditEvent, type AuditEvent } from "@/lib/audit/write";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";

export interface AuditParams {
  action: string;
  tableName?: string | null;
  recordId?: string | null;
  data?: Record<string, unknown> | null;
  outcome?: "success" | "failure";
}

export function auditEventFromParams(actorId: string, params: AuditParams): AuditEvent {
  return {
    actorId,
    action: params.action,
    targetTable: params.tableName ?? null,
    targetId: params.recordId ?? null,
    outcome: params.outcome ?? "success",
    metadata: params.data ?? null,
  };
}

// Compatibility helper for legacy callers. New mutations should write within
// their own transaction; this preserves the old best-effort contract.
export async function recordAudit(params: AuditParams): Promise<void> {
  try {
    const session = await getRequiredSession();
    await withUserTransaction(session, (client) =>
      writeAuditEvent(client, auditEventFromParams(session.userId, params)),
    );
  } catch {
    // Audit failure must not break the legacy caller.
  }
}
