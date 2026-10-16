"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession } from "@/lib/auth/session";
import { markScrPending } from "@/lib/scr/queries";
import type { EntityKind } from "@/types/app";

export async function resendScr(scrId: string, _document: string, _type: EntityKind, _name: string | null, email: string | null): Promise<{ ok: boolean }> {
  let session; try { session = await getRequiredSession(); } catch { return { ok: false }; }
  await markScrPending(session, scrId, email);
  revalidatePath("/scr"); return { ok: true };
}
