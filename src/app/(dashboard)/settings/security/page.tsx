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
          <CardTitle className="text-lg">Autenticador</CardTitle>
          <CardDescription>
            Use um app como Google Authenticator, Authy ou 1Password. Consultores
            e administradores precisam de um autenticador ativo para acessar o
            painel; para clientes é opcional.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <p className="text-sm text-emerald-700">
              Autenticador confirmado com sucesso.
            </p>
          ) : (
            <MfaEnrollment onComplete={() => setDone(true)} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
