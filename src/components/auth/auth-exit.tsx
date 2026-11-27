import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { signOut } from "@/actions/auth";
import { Button } from "@/components/ui/button";

// Saída no topo das telas de acesso. Cada tela usa só uma: o e2e procura um único "Sair".
export function SignOutButton() {
  return (
    <form action={signOut} className="flex justify-end">
      <Button type="submit" variant="ghost">
        Sair
      </Button>
    </form>
  );
}

export function BackToLogin() {
  return (
    <Link
      href="/login"
      className="inline-flex min-h-11 items-center gap-2 text-base font-bold text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft aria-hidden className="size-5" />
      Voltar ao login
    </Link>
  );
}
