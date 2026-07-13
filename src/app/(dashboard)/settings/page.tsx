import Link from "next/link";
import {
  Bot,
  FileSignature,
  Percent,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth";

export default async function SettingsPage() {
  const profile = await getCurrentProfile();
  const admin = profile?.role === "admin";

  return (
    <div>
      <PageHeader
        title="Configurações"
        description="Gestão da conta e da operação"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/settings/security">
          <Card className="h-full transition-colors hover:bg-muted/50">
            <CardHeader>
              <ShieldCheck className="mb-2 h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Segurança (MFA)</CardTitle>
              <CardDescription>
                Cadastre um autenticador TOTP para sua conta.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>

        {admin && (
          <Link href="/settings/users">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <Users className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Usuários</CardTitle>
                <CardDescription>
                  Crie e gerencie consultores e administradores.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}

        {admin && (
          <Link href="/settings/prompts">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <Bot className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Prompts da IA</CardTitle>
                <CardDescription>
                  Edite os prompts dos analisadores PF, PJ e de Empresa.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}

        {admin && (
          <Link href="/settings/scr">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <FileSignature className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Termo SCR</CardTitle>
                <CardDescription>
                  Configure o termo de consentimento da autogestão de SCR.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}

        {admin && (
          <Link href="/settings/commission">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <Percent className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Comissão</CardTitle>
                <CardDescription>
                  Defina a comissão bruta padrão estimada (% do aprovado).
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}

        {admin && (
          <Link href="/settings/audit">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <ScrollText className="mb-2 h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Auditoria</CardTitle>
                <CardDescription>
                  Trilha de acessos ao bureau (quem consultou o quê e quando).
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}
      </div>
    </div>
  );
}
