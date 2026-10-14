"use server";

import { z } from "zod";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listLedger, type LedgerPage } from "@/lib/wallet/queries";

const schema = z.object({ bureauId: z.string().uuid(), cursor: z.string().regex(/^\d{1,18}$/) });

const NOT_ALLOWED = "Você não tem permissão para ver a carteira.";

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(error: unknown): void {
  const meta =
    error instanceof Error
      ? { name: error.name, code: "code" in error ? error.code : undefined }
      : { name: typeof error };
  console.error("[wallet] loadMoreLedgerAction falhou", meta);
}

export type LedgerPageResult = { error: string | null; page?: LedgerPage };

// Próxima página do extrato. O RLS limita o Bureau visível a cada papel.
export async function loadMoreLedgerAction(values: unknown): Promise<LedgerPageResult> {
  const parsed = schema.safeParse(values);
  if (!parsed.success) return { error: "Dados inválidos." };
  try {
    const session = await getRequiredSession();
    if (!hasPermission(session, "wallet:read")) return { error: NOT_ALLOWED };
    // Só o superadmin escolhe o Bureau; os demais papéis leem o próprio, ignorando o id enviado.
    const bureauId = session.role === "superadmin" ? parsed.data.bureauId : session.bureauId;
    if (!bureauId) return { error: NOT_ALLOWED };
    const page = await withUserTransaction(session, (client) =>
      listLedger(client, bureauId, { cursor: parsed.data.cursor }),
    );
    return { error: null, page };
  } catch (error) {
    if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
    logFailure(error);
    return { error: "Não foi possível carregar o extrato." };
  }
}
