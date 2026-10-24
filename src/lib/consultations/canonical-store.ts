import type { PoolClient } from "pg";

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { CanonicalBureauResult } from "@/types/bureau";

// Reads Task 7's `bureau_results.canonical_result` for one consultation, inside a
// user-scoped transaction (RLS enforced). Returns null when there is no canonical
// row yet — historical consultations are backfilled in Task 14, and
// `payload_incompatible` consultations never get a `bureau_results` row.
export async function loadCanonicalResult(
  identity: DbIdentity,
  consultationId: string,
): Promise<CanonicalBureauResult | null> {
  return withUserTransaction(identity, async (client: PoolClient) => {
    const { rows } = await client.query(
      "select canonical_result from bureau_results where consultation_id = $1",
      [consultationId],
    );
    return rows.length
      ? (rows[0].canonical_result as CanonicalBureauResult)
      : null;
  });
}

// Payload bruto da consulta, sob RLS: o referenciado por bureau_results.payload_id (o validado) quando há resultado,
// senão o mais recente. null se não houver (purgado ou nunca recebido).
export async function loadLatestPayload(
  identity: DbIdentity,
  consultationId: string,
): Promise<unknown> {
  return withUserTransaction(identity, async (client: PoolClient) => {
    const { rows } = await client.query<{ payload: unknown }>(
      `select bp.payload from bureau_payloads bp
        left join bureau_results r on r.consultation_id = bp.consultation_id
        where bp.consultation_id = $1
        order by (bp.id is not distinct from r.payload_id) desc, bp.received_at desc limit 1`,
      [consultationId],
    );
    return rows[0]?.payload ?? null;
  });
}
