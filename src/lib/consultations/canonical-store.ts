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
