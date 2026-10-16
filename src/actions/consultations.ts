"use server";

import { listHolders } from "@/lib/holders/queries";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { hasPermission } from "@/lib/db/permissions";
import { onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

const currentIdentity = async () => { try { return await getRequiredSession(); } catch { return null; } };

const PICK_LIMIT = 10;
export interface HolderPick { id: string; type: EntityKind; name: string; document: string; email: string | null; }
export async function searchHolders(term: string): Promise<HolderPick[]> {
  const identity = await currentIdentity(); if (!identity) return [];
  if (!hasPermission(identity, "holders:read")) return [];
  const rows = await listHolders(identity, { q: term });
  return rows.slice(0, PICK_LIMIT).map(({ id, type, name, document, email }) => ({ id, type, name, document, email }));
}
export interface RecentConsultationResult { exists: boolean; queryId?: string; consultedAt?: string; }
export async function findRecentConsultation(document: string): Promise<RecentConsultationResult> {
  const identity = await currentIdentity(); if (!identity) return { exists: false };
  const { rows } = await withUserTransaction(identity, (client) => client.query<{ id: string; consulted_at: string }>(`select id,consulted_at::text from consultations where document=$1 and status='completed' and consulted_at>=now()-interval '30 days' order by consulted_at desc limit 1`, [onlyDigits(document)]));
  return rows[0] ? { exists: true, queryId: rows[0].id, consultedAt: rows[0].consulted_at } : { exists: false };
}
