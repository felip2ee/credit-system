"use client";

import { signOut } from "@/actions/auth";
import { MfaEnrollment } from "@/components/auth/mfa-enrollment";
import { Button } from "@/components/ui/button";
import { AuthHeading } from "@/components/auth/auth-heading";

export default function MfaSetupPage() {
  return (
    <section className="w-full max-w-md space-y-8">
      <AuthHeading title="Configurar dois fatores" description="Sua conta exige um app autenticador para acessar o painel." />
      <div className="space-y-5">
        <MfaEnrollment onComplete={() => (window.location.href = "/")} />
        <form action={signOut}>
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Sair
          </Button>
        </form>
      </div>
    </section>
  );
}
