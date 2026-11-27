"use client";

import { useState } from "react";

import { MfaEnrollment } from "@/components/auth/mfa-enrollment";
import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";

export default function SecurityPage() {
  const [done, setDone] = useState(false);

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="Segurança (MFA)"
        description="Autenticação em dois fatores via aplicativo TOTP"
      />

      <Card>
        <CardHeader>
          <CardTitle>Autenticador</CardTitle>
          <CardDescription>
            Use um app como Google Authenticator, Authy ou 1Password. Consultores
            e administradores precisam de um autenticador ativo para acessar o
            painel; para clientes é opcional.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <StatusBanner
              tone="success"
              title="Autenticador confirmado com sucesso."
              description="Quando o login pedir o código, abra o aplicativo autenticador e digite o código que ele mostra."
            />
          ) : (
            <MfaEnrollment onComplete={() => setDone(true)} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
