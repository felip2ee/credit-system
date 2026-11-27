"use client";

import { MfaEnrollment } from "@/components/auth/mfa-enrollment";
import { SignOutButton } from "@/components/auth/auth-exit";
import { AuthHeading } from "@/components/auth/auth-heading";

export default function MfaSetupPage() {
  return (
    <section className="w-full max-w-md space-y-6">
      <SignOutButton />
      <AuthHeading title="Configurar dois fatores" description="Sua conta exige um app autenticador para acessar o painel." />
      <MfaEnrollment onComplete={() => (window.location.href = "/")} />
    </section>
  );
}
