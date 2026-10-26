"use server";

import { revalidatePath } from "next/cache";

import { z } from "zod";

import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { listScrSendHistory, markScrPending } from "@/lib/scr/queries";
import type { ScrSendRecord } from "@/lib/scr/send-history";
import type { EntityKind } from "@/types/app";

export async function resendScr(scrId: string, _document: string, _type: EntityKind, _name: string | null, email: string | null): Promise<{ ok: boolean }> {
  let session; try { session = await getRequiredSession(); } catch { return { ok: false }; }
  await markScrPending(session, scrId, email);
  revalidatePath("/scr"); return { ok: true };
}

export async function getScrSendHistory(scrId: string): Promise<{ error: string | null; history: ScrSendRecord[] }> {
  const parsed = z.string().uuid().safeParse(scrId);
  if (!parsed.success) return { error: "Registro SCR inválido.", history: [] };
  let session; try { session = await getRequiredSession(); } catch { return { error: "Sessão expirada.", history: [] }; }
  if (!hasPermission(session, "consultations:read")) return { error: "Sem permissão.", history: [] };
  return { error: null, history: await listScrSendHistory(session, parsed.data) };
}
