"use client";

import { signOut } from "@/actions/auth";
import { MfaEnrollment } from "@/components/auth/mfa-enrollment";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function MfaSetupPage() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Configurar dois fatores</CardTitle>
        <CardDescription>
          Sua conta exige um app autenticador para acessar o painel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MfaEnrollment onComplete={() => (window.location.href = "/")} />
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            Sair
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
