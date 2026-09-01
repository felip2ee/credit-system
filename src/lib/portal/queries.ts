import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { OpportunityStatus } from "@/types/app";

export type PortalOpportunity = {
  id: string;
  status: OpportunityStatus;
  requested_amount: number | null;
  credit_purpose: string | null;
  created_at: string;
};

export async function listPortalOpportunities(
  identity: DbIdentity,
): Promise<PortalOpportunity[]> {
  return withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<PortalOpportunity>(
      `select id, status, requested_amount::float8 as requested_amount,
              credit_purpose, created_at::text
         from opportunities
        order by created_at desc`,
    );
    return rows;
  });
}
