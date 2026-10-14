import { redirect } from "next/navigation";

import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";

// A tela só existe para quem tem a flag de troca obrigatória.
export default async function ChangePasswordLayout({ children }: { children: React.ReactNode }) {
  try {
    await getRequiredSession();
  } catch (err) {
    const path = sessionErrorPath(err);
    if (path !== "/change-password") redirect(path);
    return children;
  }
  redirect("/");
}
