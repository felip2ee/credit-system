"use server";

import { z } from "zod";

import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listLedger, type LedgerPage } from "@/lib/wallet/queries";

const schema = z.object({ bureauId: z.string().uuid(), cursor: z.string().regex(/^\d{1,18}$/) });

export type LedgerPageResult = { error: string | null; page?: LedgerPage };

// Próxima página do extrato. O RLS limita o Bureau visível a cada papel.
export async function loadMoreLedgerAction(values: unknown): Promise<LedgerPageResult> {
  const parsed = schema.safeParse(values);
  if (!parsed.success) return { error: "Dados inválidos." };
  try {
    const session = await getRequiredSession();
    if (!hasPermission(session, "wallet:read")) return { error: "Você não tem permissão para ver a carteira." };
    const page = await withUserTransaction(session, (client) =>
      listLedger(client, parsed.data.bureauId, { cursor: parsed.data.cursor }),
    );
    return { error: null, page };
  } catch {
    return { error: "Não foi possível carregar o extrato." };
  }
}
