"use server";

import { z } from "zod";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listClientLedger, type ClientLedgerEntry } from "@/lib/wallet/client-queries";

const schema = z.object({ cursor: z.string().regex(/^\d{1,18}$/) });

const NOT_ALLOWED = "Você não tem permissão para ver o extrato.";

// Só as colunas que a tela mostra: sem seq, referência nem autor.
export type ClientLedgerRow = {
  id: string;
  kind: ClientLedgerEntry["kind"];
  amount: string;
  availableAfter: string;
  reservedAfter: string;
  reason: string | null;
  createdAt: Date;
};

export type ClientLedgerPageResult = {
  error: string | null;
  page?: { rows: ClientLedgerRow[]; nextCursor: string | null };
};

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(error: unknown): void {
  const meta =
    error instanceof Error
      ? { name: error.name, code: "code" in error ? error.code : undefined }
      : { name: typeof error };
  console.error("[credits] loadMoreClientLedgerAction falhou", meta);
}

// Próxima página do extrato do próprio cliente: o perfil vem da sessão, nunca do pedido.
export async function loadMoreClientLedgerAction(values: unknown): Promise<ClientLedgerPageResult> {
  const parsed = schema.safeParse(values);
  if (!parsed.success) return { error: "Dados inválidos." };
  try {
    const session = await getRequiredSession();
    if (!hasPermission(session, "credits:read")) return { error: NOT_ALLOWED };
    const page = await withUserTransaction(session, (client) =>
      listClientLedger(client, session.userId, { cursor: parsed.data.cursor }),
    );
    return {
      error: null,
      page: {
        nextCursor: page.nextCursor,
        rows: page.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          amount: r.amount,
          availableAfter: r.availableAfter,
          reservedAfter: r.reservedAfter,
          reason: r.reason,
          createdAt: r.createdAt,
        })),
      },
    };
  } catch (error) {
    if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
    logFailure(error);
    return { error: "Não foi possível carregar o extrato." };
  }
}
