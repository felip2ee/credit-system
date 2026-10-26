"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/server";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { removePushSubscription } from "@/lib/notifications/push-subscriptions";
import { pushEndpointSchema } from "@/lib/validators/push";

// O aparelho que sai da conta deixa de receber avisos dela. Falha aqui nunca prende o cliente na sessão.
async function removeDevicePush(formData: FormData | undefined): Promise<void> {
  const parsed = pushEndpointSchema.safeParse(formData?.get("pushEndpoint"));
  if (!parsed.success) return;
  try {
    const session = await getRequiredSession();
    if (session.role !== "client") return;
    await withUserTransaction(session, (client) => removePushSubscription(client, parsed.data));
  } catch (error) {
    // Só o nome do erro: o endpoint identifica o aparelho e não vai para o log.
    console.warn("[auth] remoção do aparelho falhou", { name: error instanceof Error ? error.name : typeof error });
  }
}

export async function signOut(formData?: FormData) {
  await removeDevicePush(formData);
  await auth.api.signOut({ headers: new Headers(headers()) });
  redirect("/login");
}
