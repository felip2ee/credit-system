import { redirect } from "next/navigation";

import { HolderForm } from "@/components/holders/holder-form";
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export default async function NewHolderPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "holders:write")) redirect("/holders");

  return <HolderForm />;
}
