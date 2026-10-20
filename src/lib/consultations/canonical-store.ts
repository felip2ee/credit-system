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

// Payload bruto mais recente da consulta, sob RLS; null se não houver (purgado ou nunca recebido).
export async function loadLatestPayload(
  identity: DbIdentity,
  consultationId: string,
): Promise<unknown> {
  return withUserTransaction(identity, async (client: PoolClient) => {
    const { rows } = await client.query<{ payload: unknown }>(
      "select payload from bureau_payloads where consultation_id = $1 order by received_at desc limit 1",
      [consultationId],
    );
    return rows[0]?.payload ?? null;
  });
}
